import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSourceFiles, exportedFunctions, readSource, QUERY_VERBS } from '../../../test/support/repoGuard.js';

/**
 * Static guard for the one rule that cannot be allowed to regress: every query on an
 * org-owned table must be scoped by `orgId`.
 *
 * A missing filter is not a bug, it is one landlord reading another's portfolio. Code
 * review catches most of these; this catches the rest, on every PR, for free — no
 * database required.
 *
 * History: this guard used to call a non-recursive `readdirSync`, so anything under
 * a subdirectory (e.g. `db/repo/portal/`) was invisible to it — see
 * docs/PLAN-V1.md §0.2.A. `listSourceFiles` (test/support/repoGuard.ts) now recurses. The
 * "recursion proof" suite at the bottom of this file demonstrates, against a throwaway
 * fixture directory, that a violation placed in a nested subdirectory is still caught.
 */

const REPO_DIR = dirname(fileURLToPath(import.meta.url));

// `db/repo/portal/**` and `db/repo/system/**` (the latter lands in a later phase) take
// a different first parameter by design (`scope: TenantScope`, no caller principal at
// all) and are covered by their own dedicated guards — see
// `db/repo/portal/portal-tenancy.guard.test.ts`. `db/repo/public/**` takes no scope at
// all by design (there is none yet — see its module comment) and is covered by
// `db/repo/public/invite-lookup.guard.test.ts`. `db/repo/auth/**` touches Better
// Auth's own (non-org-owned) tables and is covered by
// `db/repo/auth/auth-tables.guard.test.ts`. Excluding them here is not a loophole:
// every file in the repo tree is claimed by exactly one guard, never by zero.
const EXEMPT_PREFIXES = ['portal/', 'system/', 'public/', 'auth/'];

function landlordRepoFiles(): string[] {
  return listSourceFiles(REPO_DIR).filter((f) => !EXEMPT_PREFIXES.some((p) => f.startsWith(p)));
}

/**
 * Bump this UP whenever a legitimate landlord repo file is added. Never lower it to
 * make a failing suite pass — the entire point of a floor is that an empty (or
 * near-empty) glob fails loudly instead of silently passing every `it()` below
 * vacuously, which is exactly how the original bug went unnoticed.
 */
const MIN_LANDLORD_REPO_FILES = 4; // property.ts, unit.ts, tenant.ts, lease.ts

describe('tenant isolation guard', () => {
  const files = landlordRepoFiles();

  it('finds the repository directory', () => {
    expect(REPO_DIR).toContain(join('db', 'repo'));
  });

  it('discovers at least the expected floor of landlord repo files', () => {
    expect(
      files.length,
      `Expected at least ${MIN_LANDLORD_REPO_FILES} landlord repo files, found ${files.length}: ` +
        `[${files.join(', ')}]. If this is a refactor that legitimately removes files, lower the ` +
        'floor explicitly and explain why in the same commit. If it is not, something broke ' +
        'file discovery and every check below is about to pass for the wrong reason.',
    ).toBeGreaterThanOrEqual(MIN_LANDLORD_REPO_FILES);
  });

  for (const file of files) {
    describe(file, () => {
      const src = readSource(REPO_DIR, file);
      const fns = exportedFunctions(src);

      it('exports at least one function', () => {
        expect(fns.length).toBeGreaterThan(0);
      });

      for (const fn of fns) {
        // Functions that never touch the db (mappers, formatters) are exempt.
        if (!QUERY_VERBS.test(fn.body)) continue;

        it(`${fn.name}() takes orgId as its first parameter`, () => {
          const first = fn.params.split(',')[0]?.trim() ?? '';
          expect(
            /^orgId\s*:/.test(first),
            `${file} :: ${fn.name}() must take \`orgId: string\` first, got \`${first || '(none)'}\`. ` +
              'Tenancy comes from the session via c.get("orgId"), never from the request.',
          ).toBe(true);
        });

        it(`${fn.name}() filters by orgId`, () => {
          expect(
            /\borgId\b/.test(fn.body),
            `${file} :: ${fn.name}() runs a query without referencing orgId. ` +
              'Every read, update and delete on an org-owned table must include it in WHERE — ' +
              "otherwise one landlord can reach another landlord's rows.",
          ).toBe(true);
        });
      }
    });
  }
});

describe('recursion proof', () => {
  // Builds a throwaway `<tmp>/bad/leak.ts` — a file in a SUBDIRECTORY, exactly the
  // shape that escaped the old non-recursive guard — and proves the fixed file
  // discovery still finds it, and the violation-detection logic still flags it.
  // This is not an abstract claim; it is run against a real nested file every time
  // the suite runs.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'repo-guard-fixture-'));

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('finds a file nested in a subdirectory', () => {
    mkdirSync(join(fixtureRoot, 'bad'), { recursive: true });
    writeFileSync(
      join(fixtureRoot, 'bad', 'leak.ts'),
      [
        '// Deliberately missing orgId — this is the violation under test.',
        'export async function leakAcrossOrgs(id, db) {',
        "  return db.select().from('tenant').where(id);",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const files = listSourceFiles(fixtureRoot);
    expect(files).toContain('bad/leak.ts');
  });

  it('flags the missing-orgId violation once the nested file is found', () => {
    const src = readSource(fixtureRoot, 'bad/leak.ts');
    const [fn] = exportedFunctions(src);
    expect(fn, 'expected the fixture to parse one exported function').toBeDefined();
    expect(QUERY_VERBS.test(fn!.body)).toBe(true);

    const first = fn!.params.split(',')[0]?.trim() ?? '';
    // This is the exact assertion the main suite above runs on every real repo file.
    // Here it must FAIL (the fixture is deliberately bad), which is what proves the
    // recursive guard would catch this if it were committed for real.
    expect(/^orgId\s*:/.test(first)).toBe(false);
  });

  it('a well-formed nested file would pass the same check', () => {
    writeFileSync(
      join(fixtureRoot, 'bad', 'fixed.ts'),
      [
        "import { and, eq } from 'drizzle-orm';",
        'export async function listSomething(orgId: string, db: unknown) {',
        "  return (db as { select: () => unknown }).select().from('tenant')" +
          ".where(and(eq('tenant.orgId', orgId)));",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const src = readSource(fixtureRoot, 'bad/fixed.ts');
    const [fn] = exportedFunctions(src);
    const first = fn!.params.split(',')[0]?.trim() ?? '';
    expect(/^orgId\s*:/.test(first)).toBe(true);
    expect(/\borgId\b/.test(fn!.body)).toBe(true);
  });
});
