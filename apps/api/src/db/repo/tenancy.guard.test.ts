import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for the one rule that cannot be allowed to regress: every query on an
 * org-owned table must be scoped by `orgId`.
 *
 * A missing filter is not a bug, it is one landlord reading another's portfolio. Code
 * review catches most of these; this catches the rest, on every PR, for free — no
 * database required.
 */

const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const QUERY_VERBS = /\bdb\s*\.\s*(select|insert|update|delete|query)\b/;

function repoFiles(): string[] {
  return readdirSync(REPO_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'),
  );
}

/** Splits a source file into top-level exported functions by brace matching. */
function exportedFunctions(src: string): { name: string; params: string; body: string }[] {
  const out: { name: string; params: string; body: string }[] = [];
  const header = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;

  for (let m = header.exec(src); m; m = header.exec(src)) {
    const name = m[1]!;
    let i = m.index + m[0].length;

    // Walk the parameter list to its closing paren.
    let depth = 1;
    const paramStart = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const params = src.slice(paramStart, i - 1);

    // Walk to the opening brace, then match it.
    while (i < src.length && src[i] !== '{') i++;
    const bodyStart = ++i;
    depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ name, params, body: src.slice(bodyStart, i - 1) });
  }
  return out;
}

/** Strips comments and string literals so a mention inside either never counts. */
function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

describe('tenant isolation guard', () => {
  const files = repoFiles();

  it('finds the repository directory', () => {
    // A rename that silently empties this guard would be worse than no guard at all.
    expect(REPO_DIR).toContain(join('db', 'repo'));
  });

  for (const file of files) {
    describe(file, () => {
      const src = stripNoise(readFileSync(join(REPO_DIR, file), 'utf8'));
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
              'otherwise one landlord can reach another landlord\'s rows.',
          ).toBe(true);
        });
      }
    });
  }
});
