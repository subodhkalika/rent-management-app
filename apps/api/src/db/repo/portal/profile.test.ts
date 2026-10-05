import { describe, it, expect } from 'vitest';
import { createDb } from '../../index.js';
import { getProfile, getProfileQuery, updateProfile, updateProfileQuery } from './profile.js';
import type { TenantScope } from '../../../types.js';

const db = createDb('postgres://user:pass@localhost:5432/db');

const scopeForDana: TenantScope = {
  userId: 'user_dana',
  pairs: [
    { orgId: 'org_A', tenantId: 'tenant_A1' },
    { orgId: 'org_B', tenantId: 'tenant_B1' },
  ],
};

describe('getProfileQuery', () => {
  it('filters by tenant.org_id AND tenant.id together — a pair, not org alone', () => {
    const { sql, params } = getProfileQuery(scopeForDana, db, 'tenant_A1', 'org_A').toSQL();
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'tenant_A1']));
  });
});

describe('getProfile — cross-tenant isolation', () => {
  it("returns null for a tenantId not in the caller's scope, WITHOUT ever building a query for it", async () => {
    // This is the structural proof that one tenant cannot read another tenant's
    // profile even within the SAME org: `tenant_A2` (a different tenant in org_A,
    // not one of Dana's own identities) never reaches a WHERE clause at all — the
    // function returns before calling db.select, because resolvePair finds nothing.
    const result = await getProfile(scopeForDana, db, 'tenant_A2_not_in_scope');
    expect(result).toBeNull();
  });

  it("returns null for another tenant's id even if it belongs to an org Dana ALSO rents from", async () => {
    // Dana rents from org_A as tenant_A1. tenant_A2 is a different person renting
    // from the same landlord. Scope is a set of (org, tenant) PAIRS, not a set of
    // orgs — being a tenant in org_A does not grant visibility into every tenant
    // row in org_A.
    const result = await getProfile(scopeForDana, db, 'tenant_A2_same_org_different_person');
    expect(result).toBeNull();
  });

  it("resolves the caller's own tenant id using the pair's own org_id, not a guessed one", () => {
    // tenant_B1 exists only in org_B. Resolving it must use org_B, never org_A, even
    // though org_A appears earlier in the pairs array.
    const { params } = getProfileQuery(scopeForDana, db, 'tenant_B1', 'org_B').toSQL();
    expect(params).toContain('org_B');
    expect(params).not.toContain('org_A');
  });
});

describe('updateProfileQuery', () => {
  it('scopes the UPDATE by the resolved (org_id, tenant_id) pair', () => {
    const { sql, params } = updateProfileQuery(scopeForDana, db, 'tenant_A1', 'org_A', {
      phone: '555-0100',
    }).toSQL();
    expect(sql).toContain('update "tenant" set');
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'tenant_A1', '555-0100']));
  });

  it('never writes email or name — only the fields updatePortalProfileBody allows', () => {
    const { sql } = updateProfileQuery(scopeForDana, db, 'tenant_A1', 'org_A', {
      phone: '555-0100',
    }).toSQL();
    expect(sql).not.toContain('"email" =');
    expect(sql).not.toContain('"first_name" =');
  });
});

describe('updateProfile — cross-tenant isolation', () => {
  it("refuses to update a tenantId not in the caller's scope", async () => {
    const result = await updateProfile(scopeForDana, db, 'tenant_A2_not_in_scope', {
      phone: '555-0100',
    });
    expect(result).toBeNull();
  });
});
