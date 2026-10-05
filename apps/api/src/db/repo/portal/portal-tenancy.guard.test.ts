import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSourceFiles, exportedFunctions, readSource, QUERY_VERBS } from '../../../../test/support/repoGuard.js';

/**
 * Static guard for `db/repo/portal/` — the tenant side of tenancy isolation.
 *
 * docs/PLAN-V1.md §1.4: every exported query function here must take
 * `scope: TenantScope` first, and its body must reference BOTH `orgId` and
 * `tenantId` — the `(orgId, tenantId)` pair filter is strictly stronger than the
 * plain `orgId` filter the landlord guard requires, not a substitute for it.
 *
 * One named exception: `resolveScope` PRODUCES a `TenantScope` from a bare `userId`,
 * so it cannot already take one — see scope.ts's module comment. It is allow-listed
 * by exact function name, not by file or convention, so adding a second un-scoped
 * function anywhere in this directory re-triggers the check immediately.
 */

const PORTAL_DIR = dirname(fileURLToPath(import.meta.url));

/** Bump UP when a legitimate portal repo file is added. Never down — see
 *  tenancy.guard.test.ts for why a floor exists at all. */
const MIN_PORTAL_REPO_FILES = 3; // scope.ts, profile.ts, lease.ts

// `resolveScopeQuery` is `resolveScope`'s split-out query builder (same pattern as
// property.ts/unit.ts/tenant.ts), so it is exempt for the identical reason.
const PRODUCES_SCOPE = new Set(['resolveScope', 'resolveScopeQuery']);

describe('portal tenancy guard', () => {
  const files = listSourceFiles(PORTAL_DIR);

  it('discovers at least the expected floor of portal repo files', () => {
    expect(
      files.length,
      `Expected at least ${MIN_PORTAL_REPO_FILES} portal repo files, found ${files.length}: ` +
        `[${files.join(', ')}].`,
    ).toBeGreaterThanOrEqual(MIN_PORTAL_REPO_FILES);
  });

  for (const file of files) {
    describe(file, () => {
      const src = readSource(PORTAL_DIR, file);
      const fns = exportedFunctions(src);

      it('exports at least one function', () => {
        expect(fns.length).toBeGreaterThan(0);
      });

      for (const fn of fns) {
        if (!QUERY_VERBS.test(fn.body)) continue;

        if (PRODUCES_SCOPE.has(fn.name)) {
          it(`${fn.name}() is the scope-producing exception: takes userId first, not scope`, () => {
            const first = fn.params.split(',')[0]?.trim() ?? '';
            expect(
              /^userId\s*:/.test(first),
              `${file} :: ${fn.name}() is allow-listed as the function that builds a TenantScope, so ` +
                `it must take \`userId: string\` first, got \`${first || '(none)'}\`.`,
            ).toBe(true);
          });
          continue;
        }

        it(`${fn.name}() takes scope: TenantScope as its first parameter`, () => {
          const first = fn.params.split(',')[0]?.trim() ?? '';
          expect(
            /^scope\s*:\s*TenantScope\b/.test(first),
            `${file} :: ${fn.name}() must take \`scope: TenantScope\` first, got \`${first || '(none)'}\`. ` +
              'Only resolveScope (which builds the scope) is exempt.',
          ).toBe(true);
        });

        it(`${fn.name}() references both orgId and tenantId — a pair filter, not org alone`, () => {
          expect(
            /\borgId\b/.test(fn.body),
            `${file} :: ${fn.name}() never references orgId.`,
          ).toBe(true);
          expect(
            /\btenantId\b/.test(fn.body),
            `${file} :: ${fn.name}() never references tenantId. A scope check that only narrows by ` +
              'orgId would let one tenant in an org reach another tenant in the SAME org — the pair ' +
              'filter is the whole point.',
          ).toBe(true);
        });
      }
    });
  }
});
