import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSourceFiles } from '../../../../test/support/repoGuard.js';

/**
 * `db/repo/auth/` is where a route's otherwise-inline query against a Better Auth
 * table (user, member, organization, …) is supposed to land instead — see
 * user.ts's module comment. These tables are not org-owned, so the ordinary
 * `orgId`-first rule does not apply here (`tenancy.guard.test.ts` excludes this
 * directory by prefix).
 *
 * What this guard enforces INSTEAD: every file here imports from `schema.js` ONLY
 * the Better Auth tables themselves — never a domain table (`tenant`, `property`,
 * `unit`, …). The moment a function here imports `tenant` to join through
 * `tenant.user_id`, or `property` through some future convenience helper, it is
 * reaching org-owned data with no `orgId` guard over it, which is exactly the risk
 * this directory exists to keep narrow and visible.
 *
 * Unlike the other guards, this one reads the RAW file (not the comment/string-
 * stripped source `readSource` produces elsewhere) — stripping string literals would
 * blank out the `from '../../schema.js'` specifier this guard greps for.
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const MIN_AUTH_REPO_FILES = 2; // user.ts, organization.ts

const ALLOWED_TABLES = new Set([
  'user',
  'member',
  'organization',
  'session',
  'account',
  'verification',
  'invitation',
]);

const SCHEMA_IMPORT = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]*schema\.js['"]/g;

function importedSchemaNames(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(SCHEMA_IMPORT)) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe('auth-tables guard', () => {
  const files = listSourceFiles(DIR);

  it('discovers at least the expected floor of auth repo files', () => {
    expect(
      files.length,
      `Expected at least ${MIN_AUTH_REPO_FILES} files under db/repo/auth/, found ${files.length}.`,
    ).toBeGreaterThanOrEqual(MIN_AUTH_REPO_FILES);
  });

  for (const file of files) {
    it(`${file} imports from schema.js only Better Auth's own tables`, () => {
      const src = readFileSync(join(DIR, ...file.split('/')), 'utf8');
      const imported = importedSchemaNames(src);

      expect(imported.length, `${file} does not import anything from schema.js at all.`).toBeGreaterThan(0);

      for (const name of imported) {
        expect(
          ALLOWED_TABLES.has(name),
          `${file} imports "${name}" from schema.js. db/repo/auth/ may touch ONLY Better Auth's own ` +
            `tables (${[...ALLOWED_TABLES].join(', ')}) — a domain table here would be org-owned reach ` +
            'with no orgId guard over it. Put that function in db/repo/*.ts (orgId-first) instead.',
        ).toBe(true);
      }
    });
  }
});
