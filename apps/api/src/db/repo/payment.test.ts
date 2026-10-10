import { describe, it, expect } from 'vitest';
import { createDb } from '../index.js';
import {
  listPaymentsQuery,
  resolvePaymentQuery,
  existsPaymentForLeaseQuery,
} from './payment.js';
import { encodeDueDateCursor } from '../../lib/pagination.js';

/**
 * `.toSQL()` only compiles the query builder's AST — no network call, no live
 * database (see property.test.ts / charge.test.ts for the full rationale).
 * Every assertion below proves org B's orgId can never resolve to org A's
 * payment row. The orchestration functions that WRITE (recordPayment,
 * updatePaymentNote, voidPayment, correctPayment) — including the refund guard
 * and the symmetric void guard — are covered live, against real Postgres, in
 * payment.integration.test.ts.
 */
const db = createDb('postgres://user:pass@localhost:5432/db');

describe('listPaymentsQuery', () => {
  const baseOpts = { limit: 25, includeVoided: true } as const;

  it("filters by (org_id, lease_id) — org B's call can never return org A's payments", () => {
    const { sql, params } = listPaymentsQuery('org_A', db, 'lease_1', baseOpts).toSQL();
    expect(sql).toContain('"payment"."org_id" =');
    expect(sql).toContain('"payment"."lease_id" =');
    expect(params).toContain('org_A');
    expect(params).toContain('lease_1');

    const other = listPaymentsQuery('org_B', db, 'lease_1', baseOpts).toSQL();
    expect(other.params).toContain('org_B');
    expect(other.params).not.toContain('org_A');
  });

  it('excludes voided rows only when includeVoided is false', () => {
    const included = listPaymentsQuery('org_A', db, 'lease_1', { ...baseOpts, includeVoided: true }).toSQL();
    expect(included.sql).not.toContain('"payment"."voided_at" is null');

    const excluded = listPaymentsQuery('org_A', db, 'lease_1', { ...baseOpts, includeVoided: false }).toSQL();
    expect(excluded.sql).toContain('"payment"."voided_at" is null');
  });

  it('filters by from/to/kind when given', () => {
    const { sql, params } = listPaymentsQuery('org_A', db, 'lease_1', {
      ...baseOpts,
      from: '2026-01-01',
      to: '2026-12-31',
      kind: 'refund',
    }).toSQL();
    expect(sql).toContain('"payment"."received_on" >=');
    expect(sql).toContain('"payment"."received_on" <=');
    expect(sql).toContain('"payment"."kind" =');
    expect(params).toEqual(expect.arrayContaining(['2026-01-01', '2026-12-31', 'refund']));
  });

  it('orders by (received_on, id)', () => {
    const { sql } = listPaymentsQuery('org_A', db, 'lease_1', baseOpts).toSQL();
    expect(sql).toMatch(/order by "payment"."received_on" asc, "payment"."id" asc/);
  });

  it('decodes a (receivedOn, id) cursor into a row-comparison predicate', () => {
    const cursor = encodeDueDateCursor('2026-04-01', '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f');
    const { sql, params } = listPaymentsQuery('org_A', db, 'lease_1', { ...baseOpts, cursor }).toSQL();
    expect(sql).toContain('("payment"."received_on", "payment"."id") > (');
    expect(params).toContain('2026-04-01');
    expect(params).toContain('0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f');
  });
});

describe('resolvePaymentQuery — the (org_id, lease_id, id) shape resolveCharge already uses', () => {
  it('resolves by all three — a foreign lease_id or a foreign org_id both read as zero rows', () => {
    const { sql, params } = resolvePaymentQuery('org_A', db, 'lease_1', 'payment_1').toSQL();
    expect(sql).toContain('"payment"."org_id" =');
    expect(sql).toContain('"payment"."lease_id" =');
    expect(sql).toContain('"payment"."id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1', 'payment_1']));

    const other = resolvePaymentQuery('org_B', db, 'lease_1', 'payment_1').toSQL();
    expect(other.params).toContain('org_B');
    expect(other.params).not.toContain('org_A');
  });
});

describe("existsPaymentForLeaseQuery — hardDeleteLease's zero-payment precondition", () => {
  it('filters by (org_id, lease_id)', () => {
    const { sql, params } = existsPaymentForLeaseQuery('org_A', db, 'lease_1').toSQL();
    expect(sql).toContain('"payment"."org_id" =');
    expect(sql).toContain('"payment"."lease_id" =');
    expect(params).toEqual(expect.arrayContaining(['org_A', 'lease_1']));
  });
});
