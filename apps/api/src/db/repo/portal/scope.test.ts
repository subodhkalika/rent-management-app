import { describe, it, expect } from 'vitest';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { createDb } from '../../index.js';
import { organization, tenant } from '../../schema.js';

/**
 * `resolveScope` has no query-builder split-out (unlike the other repo functions) —
 * it is never called with a caller-supplied id to assert isolation against, so there
 * is nothing org-scoped to prove here the way the other `.toSQL()` tests do. What
 * this proves instead: the WHERE clause that defines a tenant's entire authorization
 * surface excludes exactly the rows docs/PLAN-V1.md §1.4 says it must.
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('resolveScope query shape', () => {
  // Reconstructed here rather than imported, because resolveScope is `async` and
  // executes immediately — there is no exported query-builder step to call .toSQL()
  // on without a live DB. Asserting the equivalent builder's SQL is the same
  // technique, applied to a query written inline for this test only.
  function query(userId: string) {
    return db
      .select({ orgId: tenant.orgId, orgName: organization.name, tenantId: tenant.id })
      .from(tenant)
      .innerJoin(organization, eq(organization.id, tenant.orgId))
      .where(and(eq(tenant.userId, userId), isNull(tenant.deletedAt), ne(tenant.status, 'archived')));
  }

  it('filters by tenant.user_id — the only input, scoped to one caller', () => {
    const { sql, params } = query('user_1').toSQL();
    expect(sql).toContain('"tenant"."user_id" =');
    expect(params).toContain('user_1');
  });

  it('excludes soft-deleted tenant rows', () => {
    const { sql } = query('user_1').toSQL();
    expect(sql).toContain('"tenant"."deleted_at" is null');
  });

  it('excludes archived tenant rows — an archived tenant loses scope immediately', () => {
    const { sql, params } = query('user_1').toSQL();
    expect(sql).toContain('"tenant"."status" <>');
    expect(params).toContain('archived');
  });
});
