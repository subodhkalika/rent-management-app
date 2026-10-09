import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import {
  listChargesQuery,
  listChargesForOrgQuery,
  resolveChargeQuery,
  existsChargeForLeaseQuery,
  latestChargedPeriodStartQuery,
} from './charge.js';
import { encodeDueDateCursor } from '../../lib/pagination.js';

/**
 * `.toSQL()` only compiles the query builder's AST — no network call, no live
 * database (see property.test.ts for the full rationale). Every assertion below
 * proves org B's orgId can never resolve to org A's charge row. The orchestration
 * functions that WRITE (createManualCharge, voidCharge, correctCharge,
 * generateChargesForLease) are covered live, against real Postgres, in
 * charge.integration.test.ts — the branching and the real unique-index behaviour
 * cannot be proven from an un-executed AST.
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listChargesQuery', () => {
  const baseOpts = { limit: 25, includeVoided: true } as const;

  it("filters by (org_id, lease_id) — org B's call can never return org A's charges", () => {
    const { sql, params } = listChargesQuery('org_A', db, 'lease_1', baseOpts).toSQL();
    expect(sql).toContain('"charge"."org_id" =');
    expect(sql).toContain('"charge"."lease_id" =');
    expect(params).toContain('org_A');
    expect(params).toContain('lease_1');

    const other = listChargesQuery('org_B', db, 'lease_1', baseOpts).toSQL();
    expect(other.params).toContain('org_B');
    expect(other.params).not.toContain('org_A');
  });

  it('excludes voided rows only when includeVoided is false', () => {
    const included = listChargesQuery('org_A', db, 'lease_1', { ...baseOpts, includeVoided: true }).toSQL();
    expect(included.sql).not.toContain('"charge"."voided_at" is null');

    const excluded = listChargesQuery('org_A', db, 'lease_1', { ...baseOpts, includeVoided: false }).toSQL();
    expect(excluded.sql).toContain('"charge"."voided_at" is null');
  });

  it('filters by from/to/type when given', () => {
    const { sql, params } = listChargesQuery('org_A', db, 'lease_1', {
      ...baseOpts,
      from: '2026-01-01',
      to: '2026-12-31',
      type: 'rent',
    }).toSQL();
    expect(sql).toContain('"charge"."due_date" >=');
    expect(sql).toContain('"charge"."due_date" <=');
    expect(sql).toContain('"charge"."type" =');
    expect(params).toEqual(expect.arrayContaining(['2026-01-01', '2026-12-31', 'rent']));
  });

  it('orders by (due_date, id) — the FIFO ordering 3b inherits unmodified', () => {
    const { sql } = listChargesQuery('org_A', db, 'lease_1', baseOpts).toSQL();
    expect(sql).toMatch(/order by "charge"."due_date" asc, "charge"."id" asc/);
  });

  it('decodes a (dueDate, id) cursor into a row-comparison predicate', () => {
    const cursor = encodeDueDateCursor('2026-04-01', '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f');
    const { sql, params } = listChargesQuery('org_A', db, 'lease_1', { ...baseOpts, cursor }).toSQL();
    expect(sql).toContain('("charge"."due_date", "charge"."id") > (');
    expect(params).toContain('2026-04-01');
    expect(params).toContain('0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f');
  });
});

describe('listChargesForOrgQuery', () => {
  const baseOpts = { limit: 25, includeVoided: true, overdueOnly: false } as const;

  it("filters by charge.org_id and scopes the lease/unit/property joins by org_id too — org B's call can never return org A's charges", () => {
    const { sql, params } = listChargesForOrgQuery('org_A', db, baseOpts).toSQL();
    expect(sql).toContain('"charge"."org_id" =');
    expect(sql).toMatch(/inner join "lease" on \("lease"\."id" = "charge"\."lease_id" and "lease"\."org_id" = \$\d+\)/);
    expect(sql).toMatch(/inner join "unit" on \("unit"\."id" = "lease"\."unit_id" and "unit"\."org_id" = \$\d+\)/);
    expect(sql).toMatch(
      /inner join "property" on \("property"\."id" = "unit"\."property_id" and "property"\."org_id" = \$\d+\)/,
    );
    expect(params).toContain('org_A');

    const other = listChargesForOrgQuery('org_B', db, baseOpts).toSQL();
    expect(other.params).toContain('org_B');
    expect(other.params).not.toContain('org_A');
  });

  it('filters by propertyId/unitId when given', () => {
    const { sql, params } = listChargesForOrgQuery('org_A', db, {
      ...baseOpts,
      propertyId: 'prop_1',
      unitId: 'unit_1',
    }).toSQL();
    expect(sql).toContain('"unit"."property_id" =');
    expect(sql).toContain('"lease"."unit_id" =');
    expect(params).toEqual(expect.arrayContaining(['prop_1', 'unit_1']));
  });

  it("overdueOnly compares due_date against the PROPERTY's own timezone, not a single server clock", () => {
    const { sql } = listChargesForOrgQuery('org_A', db, { ...baseOpts, overdueOnly: true }).toSQL();
    expect(sql).toContain('"charge"."voided_at" is null');
    expect(sql).toMatch(/"charge"."due_date" < \(now\(\) at time zone "property"."timezone"\)::date/);
  });
});

describe('resolveChargeQuery — the (org_id, lease_id, id) shape correctRentStep already uses', () => {
  it("resolves by all three — a foreign lease_id or a foreign org_id both read as zero rows", () => {
    const { sql, params } = resolveChargeQuery('org_A', db, 'lease_1', 'charge_1').toSQL();
    expect(sql).toContain('"charge"."org_id" =');
    expect(sql).toContain('"charge"."lease_id" =');
    expect(sql).toContain('"charge"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1', 'charge_1']));

    const other = resolveChargeQuery('org_B', db, 'lease_1', 'charge_1').toSQL();
    expect(other.params).toContain('org_B');
    expect(other.params).not.toContain('org_A');
  });
});

describe('existsChargeForLeaseQuery — hardDeleteLease\'s zero-charge precondition', () => {
  it('filters by (org_id, lease_id)', () => {
    const { sql, params } = existsChargeForLeaseQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toContain('"charge"."org_id" =');
    expect(sql).toContain('"charge"."lease_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1']));
  });
});

describe('latestChargedPeriodStartQuery — the rent-step mutability boundary (PLAN-PHASE3A.md §3.4)', () => {
  it('filters to GENERATED, non-voided RENT charges on this (org_id, lease_id) only', () => {
    const { sql, params } = latestChargedPeriodStartQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toContain('"charge"."org_id" =');
    expect(sql).toContain('"charge"."lease_id" =');
    expect(sql).toContain('"charge"."type" =');
    expect(sql).toContain('"charge"."source" =');
    expect(sql).toContain('"charge"."voided_at" is null');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1', 'rent', 'generated']));
  });
});
