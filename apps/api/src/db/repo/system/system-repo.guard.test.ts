import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSourceFiles, exportedFunctions, readSource } from '../../../../test/support/repoGuard.js';

/**
 * Static guard for `db/repo/system/` — the bounded cross-org exception
 * (PLAN-PHASE3A.md §6).
 *
 * Only ONE query in this whole phase is legitimately cross-org: the cron's driving
 * scan (`listLeasesForGeneration`). Everything that WRITES money stays under the
 * ordinary `orgId`-first repo (`repo/charge.ts`) and the existing tenancy guard.
 * This file enforces the shape that keeps that true:
 *
 * 1. A floor on file count, so an empty glob fails loudly rather than passing every
 *    check below vacuously — the exact bug that let the original (non-recursive)
 *    tenancy guard miss `db/repo/portal/**` entirely (docs/PLAN-V1.md §0.2.A).
 * 2. Every exported function here takes `db: Database` FIRST — there is no caller
 *    principal at this layer (no `orgId`, no `scope`); a function that needs one
 *    belongs in the ordinary repo instead.
 * 3. Every `insert(` names `orgId` as a literal column, EXCEPT `job-run.ts` — the
 *    one table in the whole schema with no `org_id` at all (schema.ts's own
 *    comment on `job_run`), named here by FILENAME, not by pattern, so a second
 *    org-less file would have to earn the same exemption explicitly.
 * 4. Every `select(` either names `orgId` or joins a table that provides it.
 * 5. Import graph: only `src/jobs/**` (or a test colocated with this directory)
 *    may import `repo/system/**`. A route importing it directly would mean the
 *    manual-kick route and the cron either diverge or need a duplicate
 *    implementation — see `repo/charge.ts`'s own module comment.
 * 6. A deliberate-violation proof — a guard with no demonstrated failure mode is a
 *    guard nobody has tested (mirrors `tenancy.guard.test.ts`'s recursion proof).
 */

const SYSTEM_DIR = dirname(fileURLToPath(import.meta.url));
// apps/api/src/db/repo/system -> apps/api/src
const SRC_DIR = join(SYSTEM_DIR, '..', '..', '..');

const MIN_SYSTEM_REPO_FILES = 2; // charges.ts, job-run.ts
const ORG_LESS_FILE = 'job-run.ts';

describe('system repo guard', () => {
  const files = listSourceFiles(SYSTEM_DIR);

  it('finds the system repo directory', () => {
    expect(SYSTEM_DIR).toContain(join('db', 'repo', 'system'));
  });

  it('discovers at least the expected floor of system repo files', () => {
    expect(
      files.length,
      `Expected at least ${MIN_SYSTEM_REPO_FILES} system repo files, found ${files.length}: ` +
        `[${files.join(', ')}]. If this is a legitimate reduction, lower the floor explicitly and ` +
        'explain why in the same commit — otherwise file discovery broke and every check below is ' +
        'passing for the wrong reason.',
    ).toBeGreaterThanOrEqual(MIN_SYSTEM_REPO_FILES);
  });

  for (const file of files) {
    describe(file, () => {
      const src = readSource(SYSTEM_DIR, file);
      const fns = exportedFunctions(src);

      it('exports at least one function', () => {
        expect(fns.length).toBeGreaterThan(0);
      });

      for (const fn of fns) {
        it(`${fn.name}() takes db: Database as its first parameter`, () => {
          const first = fn.params.split(',')[0]?.trim() ?? '';
          expect(
            /^db\s*:\s*Database\b/.test(first),
            `${file} :: ${fn.name}() must take \`db: Database\` first, got \`${first || '(none)'}\`. ` +
              'There is no caller principal at this layer — a function needing an orgId or a ' +
              'TenantScope belongs in the ordinary repo instead.',
          ).toBe(true);
        });

        if (/\binsert\s*\(/.test(fn.body)) {
          it(`${fn.name}() names orgId on every insert, unless this is the named job_run exception`, () => {
            if (file === ORG_LESS_FILE) return;
            expect(
              /\borgId\b/.test(fn.body),
              `${file} :: ${fn.name}() inserts without referencing orgId, and is not the named ` +
                `${ORG_LESS_FILE} exception. Every write under repo/system/ other than job_run must ` +
                'still carry orgId as a literal column.',
            ).toBe(true);
          });
        }

        // job-run.ts is the one table with NO org_id at all (schema.ts's own
        // comment) — a SELECT over it has nothing to name.
        if (file !== ORG_LESS_FILE && /\bselect(?:DistinctOn)?\s*\(/.test(fn.body)) {
          it(`${fn.name}() names orgId somewhere in its select`, () => {
            expect(
              /\borgId\b/.test(fn.body),
              `${file} :: ${fn.name}() selects without ever naming orgId — the one cross-org SELECT ` +
                'this phase allows still has to hand the caller a trustworthy orgId per row.',
            ).toBe(true);
          });
        }
      }
    });
  }
});

/**
 * Deliberately reads the RAW file, never `readSource`'s comment/string-stripped
 * version — an import's module specifier IS a string literal, so stripping
 * strings (the right move for every other guard in this file) would erase the
 * one thing this check needs to read. Comments are harmless to leave in here:
 * a commented-out import inside a plain `//` or `/* *‍/` is not a real import
 * either way, and this regex only runs against genuine import statements below.
 *
 * Module scope, not re-declared inside a describe block — the deliberate
 * -violation proof below calls THIS SAME FUNCTION against a throwaway fixture
 * directory, the same way `tenancy.guard.test.ts`'s recursion proof calls the
 * real `listSourceFiles`/`exportedFunctions` rather than a hand-copied
 * reimplementation. A proof that re-implements the check with its own regex
 * would keep passing even if the REAL detector below drifted.
 */
const IMPORT_RE = /from\s+['"]([^'"]*repo\/system[^'"]*)['"]/;

function importsSystemRepo(filePath: string): boolean {
  const raw = readFileSync(filePath, 'utf8');
  return IMPORT_RE.test(raw);
}

/** Every file under `srcDir` that imports `repo/system/**` without being the
 *  module itself or living under `jobs/` — the one sanctioned importer. */
function findSystemRepoImportOffenders(srcDir: string): string[] {
  return listSourceFiles(srcDir).filter((f) => {
    if (f.startsWith('db/repo/system/')) return false; // the module itself
    if (f.startsWith('jobs/')) return false; // the one sanctioned importer
    return importsSystemRepo(join(srcDir, ...f.split('/')));
  });
}

describe('system repo import graph — only jobs/ may import repo/system', () => {
  const offenders = findSystemRepoImportOffenders(SRC_DIR);

  it('no file outside src/jobs/ imports repo/system', () => {
    expect(
      offenders,
      `These files import repo/system/** without being under src/jobs/: [${offenders.join(', ')}]. ` +
        'A route importing the system repo directly means the manual-kick route and the cron would ' +
        'either diverge or need a duplicate generator implementation — the generator itself ' +
        '(generateChargesForLease) lives in the ORDINARY repo/charge.ts precisely so both callers ' +
        'share it without either needing this import.',
    ).toEqual([]);
  });
});

describe('system repo guard — detectors proven against a deliberate violation', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'system-repo-guard-fixture-'));

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('findSystemRepoImportOffenders flags a route file importing repo/system directly, and spares a jobs/ one — against a REAL fixture directory, via the ACTUAL detector', () => {
    mkdirSync(join(fixtureRoot, 'routes'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'routes', 'bad-route.ts'),
      [
        "import { listLeasesForGeneration } from '../db/repo/system/charges.js';",
        'export async function handler(db) {',
        '  return listLeasesForGeneration(db);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    mkdirSync(join(fixtureRoot, 'jobs'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'jobs', 'good-job.ts'),
      [
        "import { listLeasesForGeneration } from '../db/repo/system/charges.js';",
        'export async function runIt(db) {',
        '  return listLeasesForGeneration(db);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    // Calls the SAME function the main describe block above runs against
    // SRC_DIR — not a hand-copied regex — so this proof actually demonstrates
    // the real detector's failure mode, and would catch its own drift if that
    // function were ever weakened.
    const offenders = findSystemRepoImportOffenders(fixtureRoot);
    expect(offenders).toEqual(['routes/bad-route.ts']);
    expect(offenders).not.toContain('jobs/good-job.ts');
  });

  it('flags an exported function in repo/system/ that takes orgId first instead of db', () => {
    const src = [
      'export async function leakOrgPrincipal(orgId, db) {',
      '  return db.select().from("lease");',
      '}',
      '',
    ].join('\n');
    const [fn] = exportedFunctions(src);
    const first = fn!.params.split(',')[0]?.trim() ?? '';
    // This is exactly the assertion the main describe block runs on every real
    // file — here it must FAIL (the fixture is deliberately wrong-shaped).
    expect(/^db\s*:\s*Database\b/.test(first)).toBe(false);
  });
});
