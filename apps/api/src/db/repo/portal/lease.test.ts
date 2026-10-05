import { describe, it, expect } from 'vitest';
import { createDb } from '../../index.js';
import {
  listLeasesQuery,
  resolveLeaseQuery,
  resolveActiveLeaseQuery,
  listCoTenantsQuery,
} from './lease.js';
import type { TenantScope } from '../../../types.js';

/** `.toSQL()` only compiles the AST — no network call, no live database. */
const db = createDb('postgres://user:pass@localhost:5432/db');

const scopeForDana: TenantScope = {
  userId: 'user_dana',
  pairs: [
    { orgId: 'org_A', tenantId: 'tenant_A1' },
    { orgId: 'org_B', tenantId: 'tenant_B1' },
  ],
};

describe('listLeasesQuery — the pair filter, not org alone', () => {
  it('ORs one (lease.org_id, lease_tenant.tenant_id) clause per scope pair', () => {
    const { sql, params } = listLeasesQuery(scopeForDana, db).toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease_tenant"."tenant_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'tenant_A1', 'org_B', 'tenant_B1']));
  });

  it("excludes soft-deleted leases and is unpaginated (no limit clause)", () => {
    const { sql } = listLeasesQuery(scopeForDana, db).toSQL();
    expect(sql).toContain('"lease"."deleted_at" is null');
    expect(sql).not.toContain('limit');
  });

  it('a caller with an empty scope (should never happen — requireTenant 403s first) matches nothing, not everything', () => {
    const emptyScope: TenantScope = { userId: 'user_x', pairs: [] };
    const { sql } = listLeasesQuery(emptyScope, db).toSQL();
    expect(sql).toContain('false');
  });
});

describe('resolveLeaseQuery — §7 next-door-neighbour case', () => {
  it('filters by lease.id AND the pair filter together — org alone is not enough', () => {
    const { sql, params } = resolveLeaseQuery(scopeForDana, db, 'lease_1').toSQL();
    expect(sql).toContain('"lease"."id" =');
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease_tenant"."tenant_id" =');
    expect(params).toEqual(expect.arrayContaining(['lease_1', 'org_A', 'tenant_A1', 'org_B', 'tenant_B1']));
  });

  it("binds ONLY Dana's own tenant ids — never a neighbour's, which the query can't even express", () => {
    const { params } = resolveLeaseQuery(scopeForDana, db, 'lease_neighbours').toSQL();
    expect(params).not.toContain('tenant_neighbour');
  });
});

describe('resolveActiveLeaseQuery', () => {
  it('adds status = active and removed_on IS NULL on top of the pair filter', () => {
    const { sql, params } = resolveActiveLeaseQuery(scopeForDana, db, 'lease_1').toSQL();
    expect(sql).toContain('"lease"."status" =');
    expect(sql).toContain('"lease_tenant"."removed_on" is null');
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease_tenant"."tenant_id" =');
    expect(params).toContain('active');
  });
});

describe('listCoTenantsQuery', () => {
  it('resolves org_id from scope via the caller tenant id, and excludes the caller themselves', () => {
    const { sql, params } = listCoTenantsQuery(scopeForDana, db, 'lease_1', 'tenant_A1').toSQL();
    expect(sql).toContain('"lease_tenant"."org_id" =');
    expect(sql).toContain('"lease_tenant"."lease_id" =');
    expect(sql).toContain('"lease_tenant"."tenant_id" <>');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1', 'tenant_A1']));
  });

  it("resolves an EMPTY org_id when the caller tenant id is not in scope — matches nothing, never falls back to org alone", () => {
    const { params } = listCoTenantsQuery(scopeForDana, db, 'lease_1', 'tenant_unknown').toSQL();
    expect(params).toContain('');
  });
});
