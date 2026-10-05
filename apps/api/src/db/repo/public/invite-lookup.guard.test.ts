import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSourceFiles, exportedFunctions, readSource } from '../../../lib/repoGuard.js';

/**
 * `db/repo/public/` is the one directory where a function legitimately does NOT take
 * an `orgId` or a `scope` — there is no scope yet; the token (or, after it matches,
 * the email literally copied off that row) is the only input. See invite.ts's module
 * comment for the full reasoning.
 *
 * What this guard enforces instead: no function here accepts a `tenantId`, an
 * `orgId`, or a free-form `email` as a filtering parameter — i.e. nothing here can be
 * used to probe "does an invite exist for X". `findInviteByTokenHash` takes exactly
 * one filtering parameter, `tokenHash`. `findUserByEmail` is the one deliberate,
 * documented exception (checking account existence, not invite existence — see
 * invite.ts), so it is allow-listed by name, not exempted by convention.
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const MIN_PUBLIC_REPO_FILES = 1; // invite.ts

const FORBIDDEN_PARAM_NAMES = ['orgId', 'tenantId'];
const ALLOWED_EMAIL_PARAM_FUNCTIONS = new Set(['findUserByEmail']);

describe('public (pre-scope) repo guard', () => {
  const files = listSourceFiles(DIR);

  it('discovers at least the expected floor of public repo files', () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_PUBLIC_REPO_FILES);
  });

  for (const file of files) {
    describe(file, () => {
      const src = readSource(DIR, file);
      const fns = exportedFunctions(src);

      it('exports at least one function', () => {
        expect(fns.length).toBeGreaterThan(0);
      });

      for (const fn of fns) {
        const paramNames = fn.params
          .split(',')
          .map((p) => p.trim().split(':')[0]?.trim())
          .filter((p): p is string => Boolean(p));

        it(`${fn.name}() never takes an orgId or tenantId parameter`, () => {
          for (const forbidden of FORBIDDEN_PARAM_NAMES) {
            expect(
              paramNames.includes(forbidden),
              `${file} :: ${fn.name}() takes \`${forbidden}\` — a pre-scope lookup must never accept ` +
                'a scope-shaped parameter. If this function has established a scope, it belongs in ' +
                'db/repo/*.ts or db/repo/portal/*.ts instead.',
            ).toBe(false);
          }
        });

        it(`${fn.name}() only takes an email parameter if explicitly allow-listed`, () => {
          if (paramNames.includes('email')) {
            expect(
              ALLOWED_EMAIL_PARAM_FUNCTIONS.has(fn.name),
              `${file} :: ${fn.name}() takes \`email\` — add it to ALLOWED_EMAIL_PARAM_FUNCTIONS only ` +
                'with the same justification findUserByEmail has (checking ACCOUNT existence after a ' +
                'token already matched, never INVITE existence).',
            ).toBe(true);
          }
        });
      }
    });
  }
});
