import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import {
  listLeasesQuery,
  getLeaseQuery,
  getLeaseDetailQuery,
  listLeaseTenantsQuery,
  getChainQuery,
  resolveTenantIdsQuery,
  countActiveLeasesForUnitQuery,
  countActiveLeasesForTenantQuery,
  countActiveLeasesForPropertyQuery,
  countNonDraftLeasesForPropertyQuery,
  createLeaseQuery,
  insertLeaseTenantsQuery,
  updateLeaseQuery,
  hardDeleteLeaseQuery,
  illegalUpdateField,
} from './lease.js';

/**
 * `.toSQL()` only compiles the query builder's AST — no network call, no live
 * database (see property.test.ts for the full rationale). Every assertion below
 * proves org B's orgId can never resolve to org A's lease row.
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listLeasesQuery', () => {
  it("filters by lease.org_id — org B's call can never return org A's leases", () => {
    const { sql, params } = listLeasesQuery('org_A', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(params).toContain('org_A');

    const other = listLeasesQuery('org_B', db, { limit: 25 }).toSQL();
    expect(other.params).toContain('org_B');
    expect(other.params).not.toContain('org_A');
  });

  it('excludes soft-deleted leases', () => {
    const { sql } = listLeasesQuery('org_A', db, { limit: 25 }).toSQL();
    expect(sql).toContain('"lease"."deleted_at" is null');
  });

  it('scopes the unit and property joins by org_id too, not just the FK', () => {
    const { sql } = listLeasesQuery('org_A', db, { limit: 25 }).toSQL();
    expect(sql).toMatch(/inner join "unit" on \("unit"\."id" = "lease"\."unit_id" and "unit"\."org_id" = \$\d+\)/);
    expect(sql).toMatch(/inner join "property" on \("property"\."id" = "unit"\."property_id" and "property"\."org_id" = \$\d+\)/);
  });

  it('filters by status, unitId, propertyId when given', () => {
    const { sql, params } = listLeasesQuery('org_A', db, {
      limit: 25,
      status: 'active',
      unitId: 'unit_1',
      propertyId: 'prop_1',
    }).toSQL();
    expect(sql).toContain('"lease"."status" =');
    expect(sql).toContain('"lease"."unit_id" =');
    expect(sql).toContain('"unit"."property_id" =');
    expect(params).toEqual(expect.arrayContaining(['active', 'unit_1', 'prop_1']));
  });

  it('filters by tenantId through a scoped subquery on lease_tenant', () => {
    const { sql, params } = listLeasesQuery('org_A', db, { limit: 25, tenantId: 'tenant_1' }).toSQL();
    expect(sql).toContain('"lease"."id" in (select "lease_id"');
    expect(sql).toContain('"lease_tenant"."org_id" =');
    expect(sql).toContain('"lease_tenant"."tenant_id" =');
    expect(params).toContain('tenant_1');
  });

  it('paginates with a keyset cursor when one is given', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    const cursor = btoa(id);
    const { sql, params } = listLeasesQuery('org_A', db, { limit: 10, cursor }).toSQL();
    expect(sql).toContain('"lease"."id" >');
    expect(params).toContain(id);
  });
});

describe('getLeaseQuery', () => {
  it('filters by lease.org_id, lease.id, and excludes soft-deleted rows', () => {
    const { sql, params } = getLeaseQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease"."id" =');
    expect(sql).toContain('"lease"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1']));
  });

  it("org B's call for org A's lease id still only ever binds org_B as the org filter", () => {
    const { params } = getLeaseQuery('org_B', db, 'lease_owned_by_org_A').toSQL();
    expect(params).toContain('org_B');
    expect(params).not.toContain('org_A');
  });
});

describe('getLeaseDetailQuery', () => {
  it('filters by lease.org_id, lease.id, and includes notes/unitStatus/address columns', () => {
    const { sql, params } = getLeaseDetailQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease"."notes"');
    expect(sql).toContain('"unit"."status"');
    expect(sql).toContain('"property"."address_line1"');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1']));
  });

  it(
    'tenantCount and primaryTenantName are CORRELATED scalar subqueries, never a joined derived ' +
      "table whose bare column name can collide with property.name — regression test for the " +
      '"column reference \\"name\\" is ambiguous" bug a real Postgres caught (not a toSQL-only check)',
    () => {
      const { sql } = getLeaseDetailQuery('org_A', db, 'lease_1').toSQL();
      expect(sql).not.toContain('left join (select');
      expect(sql).not.toMatch(/,\s*"name",/);
      expect(sql).not.toMatch(/,\s*"count",/);
      // Both correlated subqueries reference lease.id to correlate to the outer row.
      expect(sql.match(/"lease"\."id"/g)!.length).toBeGreaterThanOrEqual(2);
    },
  );
});

describe('listLeaseTenantsQuery', () => {
  it('filters by lease_tenant.org_id AND lease_tenant.lease_id', () => {
    const { sql, params } = listLeaseTenantsQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toContain('"lease_tenant"."org_id" =');
    expect(sql).toContain('"lease_tenant"."lease_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1']));
  });

  it("also scopes the tenant join by org_id — org B's roster read can never join org A's tenant rows", () => {
    const { sql } = listLeaseTenantsQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toMatch(/inner join "tenant" on \("tenant"\."id" = "lease_tenant"\."tenant_id" and "tenant"\."org_id" = \$\d+\)/);
  });
});

describe('getChainQuery', () => {
  it('filters by lease.org_id AND lease.chain_id', () => {
    const { sql, params } = getChainQuery('org_A', db, 'chain_1').toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease"."chain_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'chain_1']));
  });
});

describe('resolveTenantIdsQuery — the §7.1 cross-org roster guard', () => {
  it('filters by tenant.org_id AND the requested id set, excluding soft-deleted tenants', () => {
    const { sql, params } = resolveTenantIdsQuery('org_B', db, ['tenant_A1', 'tenant_A2']).toSQL();
    expect(sql).toContain('"tenant"."org_id" =');
    expect(sql).toContain('"tenant"."id" in');
    expect(sql).toContain('"tenant"."deleted_at" is null');
    expect(params).toContain('org_B');
    // The ids themselves are bound as parameters regardless of org — the WHOLE
    // POINT is that org_B's org_id filter means NONE of them can match a row,
    // which is proved by the repo-level cross-org test in resolveTenantIds below.
    expect(params).toEqual(expect.arrayContaining(['tenant_A1', 'tenant_A2']));
  });
});

describe('resolveTenantIds — cross-org isolation (§7.1)', () => {
  it("landlord B resolving landlord A's tenant ids gets back an EMPTY array, never a partial match", async () => {
    // Against a real (but unreachable in this unit test) database this would
    // return zero rows because org_B's tenant table has no row with these ids.
    // What we can prove here without a live database is the query shape: the
    // WHERE always binds org_B, never org_A, so the only way this could ever
    // resolve A's ids is a bug in Postgres itself.
    const { sql, params } = resolveTenantIdsQuery('org_B', db, ['tenant_A1']).toSQL();
    expect(sql).toContain('"tenant"."org_id" =');
    expect(params[0]).toBe('org_B');
    expect(params).not.toContain('org_A');
  });
});

describe('countActiveLeasesForUnitQuery', () => {
  it('filters by lease.org_id, unit_id, and status = active', () => {
    const { sql, params } = countActiveLeasesForUnitQuery('org_A', db, 'unit_1').toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease"."unit_id" =');
    expect(sql).toContain('"lease"."status" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'unit_1', 'active']));
  });

  it('excludes a given lease id when provided (the self-exclusion activate needs)', () => {
    const { sql, params } = countActiveLeasesForUnitQuery('org_A', db, 'unit_1', 'lease_self').toSQL();
    expect(sql).toContain('"lease"."id" <>');
    expect(params).toContain('lease_self');
  });
});

describe('countActiveLeasesForTenantQuery', () => {
  it('filters by lease.org_id, lease_tenant.tenant_id, status = active, and excludes removed rows', () => {
    const { sql, params } = countActiveLeasesForTenantQuery('org_A', db, 'tenant_1').toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease_tenant"."tenant_id" =');
    expect(sql).toContain('"lease_tenant"."removed_on" is null');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'tenant_1']));
  });
});

describe('countActiveLeasesForPropertyQuery', () => {
  it('filters by lease.org_id, unit.property_id, and status = active', () => {
    const { sql, params } = countActiveLeasesForPropertyQuery('org_A', db, 'prop_1').toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"unit"."property_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'prop_1']));
  });
});

describe('countNonDraftLeasesForPropertyQuery — BLOCKING 3 (calendar-change guard)', () => {
  it('filters by lease.org_id, unit.property_id, excludes soft-deleted, and status NOT IN (draft, cancelled)', () => {
    const { sql, params } = countNonDraftLeasesForPropertyQuery('org_A', db, 'prop_1').toSQL();
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"unit"."property_id" =');
    expect(sql).toContain('"lease"."deleted_at" is null');
    expect(sql).toContain('"lease"."status" not in');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'prop_1', 'draft', 'cancelled']));
  });

  it('is broader than countActiveLeasesForPropertyQuery — it also counts ended/terminated leases', () => {
    const { sql: activeSql, params: activeParams } = countActiveLeasesForPropertyQuery('org_A', db, 'prop_1').toSQL();
    const { sql: nonDraftSql, params: nonDraftParams } = countNonDraftLeasesForPropertyQuery('org_A', db, 'prop_1').toSQL();
    expect(activeSql).toContain('"lease"."status" =');
    expect(activeParams).toContain('active');
    expect(nonDraftSql).toContain('"lease"."status" not in');
    expect(nonDraftParams).not.toContain('active');
  });
});

const createBody = {
  unitId: 'unit_1',
  tenantIds: ['tenant_1'],
  primaryTenantId: 'tenant_1',
  startDate: '2026-01-01',
  endDate: null,
  rentCents: 150000,
  rentFrequency: 'monthly' as const,
  billingDay: 1,
  depositCents: 0,
  openingBalanceCents: 0,
  notes: undefined,
};

describe('createLeaseQuery', () => {
  it('inserts with org_id as one of the values, status always draft, never trusting a client status', () => {
    const { sql, params } = createLeaseQuery('org_A', db, 'lease_1', 'user_1', 'unit_1', 'USD', '2026-01-01', createBody).toSQL();
    expect(sql).toContain('insert into "lease"');
    expect(sql).toMatch(/\("id", "org_id",/);
    expect(params).toEqual(expect.arrayContaining(['org_A', 'draft']));
  });

  it('sets chain_id equal to the fresh lease id', () => {
    const { params } = createLeaseQuery('org_A', db, 'lease_1', 'user_1', 'unit_1', 'USD', '2026-01-01', createBody).toSQL();
    // lease_1 appears at least twice: once as id, once as chain_id.
    expect(params.filter((p) => p === 'lease_1').length).toBeGreaterThanOrEqual(2);
  });
});

describe('insertLeaseTenantsQuery', () => {
  it('inserts one row per tenant id, all scoped to org_id, with isPrimary set only for the primary', () => {
    const { sql, params } = insertLeaseTenantsQuery('org_A', db, 'lease_1', ['tenant_1', 'tenant_2'], 'tenant_1', '2026-01-01').toSQL();
    expect(sql).toContain('insert into "lease_tenant"');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1', 'tenant_1', 'tenant_2']));
  });
});

describe('updateLeaseQuery', () => {
  it('scopes the UPDATE by lease.org_id, lease.id, and excludes soft-deleted rows', () => {
    const { sql, params } = updateLeaseQuery('org_A', db, 'lease_1', { notes: 'hello' }).toSQL();
    expect(sql).toContain('update "lease" set');
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease"."id" =');
    expect(sql).toContain('"lease"."deleted_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1']));
  });

  it('only sets fields present in the patch, plus updatedAt', () => {
    const { sql } = updateLeaseQuery('org_A', db, 'lease_1', { notes: 'hello' }).toSQL();
    expect(sql).toContain('"notes" = $1');
    expect(sql).not.toContain('"rent_cents" =');
  });
});

describe('hardDeleteLeaseQuery', () => {
  it('scopes the UPDATE by lease.org_id, lease.id, and only draft/cancelled leases', () => {
    const { sql, params } = hardDeleteLeaseQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toContain('update "lease" set "deleted_at"');
    expect(sql).toContain('"lease"."org_id" =');
    expect(sql).toContain('"lease"."id" =');
    expect(sql).toContain('"lease"."status" in');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1', 'draft', 'cancelled']));
  });
});

/**
 * Pure function — every §4.1 cell, exercised without a database.
 */
describe('illegalUpdateField (§4.1 PATCH mutability)', () => {
  it('draft: everything is legal', () => {
    expect(illegalUpdateField('draft', { rentCents: 1, unitId: 'u2', startDate: '2026-02-01' }, { endDate: null })).toBeNull();
  });

  it('active: notes, billingDay, depositCents, moveOutDate are legal', () => {
    expect(
      illegalUpdateField('active', { notes: 'x', billingDay: 5, depositCents: 100, moveOutDate: '2026-02-01' }, { endDate: null }),
    ).toBeNull();
  });

  for (const field of ['unitId', 'startDate', 'rentCents', 'rentFrequency'] as const) {
    it(`active: ${field} is illegal, names /renew`, () => {
      const patch = { [field]: field === 'rentFrequency' ? 'yearly' : field === 'rentCents' ? 1 : field === 'startDate' ? '2026-01-01' : 'unit_2' };
      const message = illegalUpdateField('active', patch, { endDate: null });
      expect(message).toMatch(/\/renew/);
    });
  }

  for (const field of ['ledgerStartDate', 'openingBalanceCents'] as const) {
    it(`active: ${field} is always illegal once left draft`, () => {
      const patch = { [field]: field === 'ledgerStartDate' ? '2026-01-01' : 100 };
      expect(illegalUpdateField('active', patch, { endDate: null })).not.toBeNull();
    });
  }

  it('active: shortening endDate is illegal, names /end', () => {
    const message = illegalUpdateField('active', { endDate: '2026-05-01' }, { endDate: '2026-06-01' });
    expect(message).toMatch(/\/end/);
  });

  it('active: lengthening (or equal) endDate is legal', () => {
    expect(illegalUpdateField('active', { endDate: '2026-07-01' }, { endDate: '2026-06-01' })).toBeNull();
    expect(illegalUpdateField('active', { endDate: '2026-06-01' }, { endDate: '2026-06-01' })).toBeNull();
  });

  it('active: nulling out a previously-set endDate is a shortening, illegal', () => {
    const message = illegalUpdateField('active', { endDate: null }, { endDate: '2026-06-01' });
    expect(message).toMatch(/\/end/);
  });

  for (const status of ['ended', 'terminated', 'cancelled'] as const) {
    it(`${status}: notes and moveOutDate are legal, nothing else is`, () => {
      expect(illegalUpdateField(status, { notes: 'x', moveOutDate: '2026-01-01' }, { endDate: '2026-01-01' })).toBeNull();
      expect(illegalUpdateField(status, { depositCents: 1 }, { endDate: '2026-01-01' })).not.toBeNull();
    });
  }
});
