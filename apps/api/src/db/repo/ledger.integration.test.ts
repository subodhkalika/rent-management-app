import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { uuidv7, allocateFifo, allocationFixtures } from '@rms/contract';
import { createDb, type Database } from '../index.js';
import { organization, user, property, unit, tenant, lease, leaseTenant, charge, payment } from '../schema.js';
import * as unitRepo from './unit.js';
import * as propertyRepo from './property.js';
import * as tenantRepo from './tenant.js';
import * as chargeRepo from './charge.js';
import * as paymentRepo from './payment.js';
import * as ledgerRepo from './ledger.js';

/**
 * REAL tests against REAL Postgres — this is the file that matters most in
 * PLAN-PHASE3B.md. `allocatedCharges` (repo/ledger.ts) is THE one window
 * function; `allocateFifo` (packages/contract/src/ledger.ts) is the same rule
 * restated in TypeScript, and the two must never silently drift apart.
 *
 * SKIPPED ENTIRELY when `DATABASE_URL` is unset. To run for real:
 * `pnpm --filter api test:live` from the repo root (never a hand-written
 * `docker compose exec` without `-T` — see lease.integration.test.ts's own
 * comment for why that hangs forever with no output).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('repo/ledger.ts — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let propertyId: string;
  let unitId: string;
  let tenantAId: string;

  beforeAll(() => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
  });

  beforeEach(async () => {
    orgId = `itest_org_${uuidv7()}`;
    otherOrgId = `itest_org_other_${uuidv7()}`;
    userId = `itest_user_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'Ledger Test Org', slug: orgId });
    await db.insert(organization).values({ id: otherOrgId, name: 'Ledger Test Org (other)', slug: otherOrgId });
    await db.insert(user).values({ id: userId, name: 'Ledger Test User', email: `${userId}@example.test` });

    const propRow = await propertyRepo.createProperty(orgId, db, {
      name: 'Test Property',
      type: 'apartment',
      address: { line1: '1 Test St', city: 'Testville', region: 'TS', postalCode: '00000', country: 'US' },
      timezone: 'UTC',
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
    });
    propertyId = propRow.id;

    const unitRow = await unitRepo.createUnit(orgId, db, propertyId, {
      label: '1A',
      bedrooms: 1,
      bathrooms: 1,
      marketRentCents: 100000,
      currency: 'USD',
      status: 'vacant',
    });
    unitId = unitRow.id;

    const tenantA = await tenantRepo.createTenant(orgId, db, {
      firstName: 'Terry',
      lastName: 'Tenant',
      status: 'active',
    });
    tenantAId = tenantA.id;
  });

  afterEach(async () => {
    for (const org of [orgId, otherOrgId]) {
      await db.delete(payment).where(eq(payment.orgId, org));
      await db.delete(charge).where(eq(charge.orgId, org));
      await db.delete(leaseTenant).where(eq(leaseTenant.orgId, org));
      await db.delete(lease).where(eq(lease.orgId, org));
      await db.delete(unit).where(eq(unit.orgId, org));
      await db.delete(property).where(eq(property.orgId, org));
      await db.delete(organization).where(eq(organization.id, org));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  /** A bare, directly-inserted lease — bypasses createLease's validation
   *  entirely, which is fine: these tests exercise ALLOCATION, never billing
   *  terms. One fresh chain per call (chainId = id), unless `chainId` is
   *  overridden to extend an existing one (the renewal test below). */
  async function insertLease(overrides: Partial<typeof lease.$inferInsert> = {}) {
    const id = uuidv7();
    const startDate = (overrides.startDate as string | undefined) ?? '2020-01-01';
    const row: typeof lease.$inferInsert = {
      id,
      orgId,
      unitId,
      chainId: id,
      startDate,
      endDate: null,
      rentCents: 100000,
      currency: 'USD',
      rentFrequency: 'monthly',
      billingDay: 1,
      depositCents: 0,
      openingBalanceCents: 0,
      // lease_ledger_ck requires ledger_start_date >= start_date — default it
      // to whatever startDate ends up being (not a fixed literal), so an
      // override that moves startDate forward (a second lease in a renewal
      // chain, say) never trips the CHECK by accident.
      ledgerStartDate: startDate,
      status: 'active',
      createdByUserId: userId,
      ...overrides,
    };
    await db.insert(lease).values(row);
    return row;
  }

  async function insertCharge(
    leaseId: string,
    opts: { id?: string; dueDate: string; amountCents: number; isVoided?: boolean; type?: typeof charge.$inferSelect.type },
  ) {
    const id = opts.id ?? uuidv7();
    await db.insert(charge).values({
      id,
      orgId,
      leaseId,
      type: opts.type ?? 'other',
      dueDate: opts.dueDate,
      amountCents: opts.amountCents,
      currency: 'USD',
      source: 'manual',
      createdByUserId: userId,
      voidedAt: opts.isVoided ? new Date() : null,
      voidedReason: opts.isVoided ? 'Voided for a fixture.' : null,
      voidedByUserId: opts.isVoided ? userId : null,
    });
    return id;
  }

  async function insertPayment(
    leaseId: string,
    opts: { kind: 'payment' | 'refund'; amountCents: number; isVoided?: boolean; receivedOn?: string },
  ) {
    const id = uuidv7();
    await db.insert(payment).values({
      id,
      orgId,
      leaseId,
      kind: opts.kind,
      method: 'bank_transfer',
      amountCents: opts.amountCents,
      currency: 'USD',
      receivedOn: opts.receivedOn ?? '2020-01-01',
      recordedByUserId: userId,
      voidedAt: opts.isVoided ? new Date() : null,
      voidedReason: opts.isVoided ? 'Voided for a fixture.' : null,
      voidedByUserId: opts.isVoided ? userId : null,
    });
    return id;
  }

  /* ======================================================================== *
   * THE ORACLE: every allocationFixtures case, inserted as real rows, compared
   * field by field to allocateFifo over the SAME input.
   * ======================================================================== */

  describe('allocatedCharges — the SQL output equals allocateFifo, fixture by fixture', () => {
    for (const fixture of allocationFixtures) {
      it(fixture.name, async () => {
        const leaseRow = await insertLease();

        // fixture charge label ("a", "dep", ...) -> the REAL uuid it was
        // inserted under, so the SQL result (keyed by real id) can be compared
        // against `expected` (keyed by fixture label) and against
        // `allocateFifo`'s own output (which the oracle call below re-derives
        // using these SAME real ids, substituted for the fixture's labels).
        const idByLabel = new Map<string, string>();
        for (const c of fixture.charges) {
          const realId = await insertCharge(leaseRow.id, {
            dueDate: c.dueDate,
            amountCents: c.amountCents,
            isVoided: c.isVoided,
          });
          idByLabel.set(c.id, realId);
        }
        for (const p of fixture.payments) {
          await insertPayment(leaseRow.id, { kind: p.kind, amountCents: p.amountCents, isVoided: p.isVoided });
        }

        const rows = await ledgerRepo.allocatedCharges(orgId, db, { chainId: leaseRow.chainId });
        expect(rows).toHaveLength(fixture.charges.length);

        // The oracle, run over the SAME charges/payments with real ids
        // substituted for fixture labels — so comparing by id is meaningful.
        const oracleInput = {
          charges: fixture.charges.map((c) => ({ ...c, id: idByLabel.get(c.id)! })),
          payments: fixture.payments,
        };
        const oracle = allocateFifo(oracleInput);
        const oracleById = new Map(oracle.map((o) => [o.id, o.appliedCents]));

        for (const row of rows) {
          // THE numeric-as-string trap: SUM(bigint) returns numeric, which the
          // Neon HTTP driver hands back as a string unless converted. Checked
          // on every row of every fixture, not just once.
          expect(typeof row.appliedCents).toBe('number');
          expect(row.appliedCents).toBe(oracleById.get(row.id));
        }

        // Also keyed by the fixture's OWN labels, against `expected` directly —
        // belt and braces on top of the oracle comparison above.
        for (const [label, expectedApplied] of Object.entries(fixture.expected)) {
          const realId = idByLabel.get(label)!;
          const row = rows.find((r) => r.id === realId)!;
          expect(row.appliedCents).toBe(expectedApplied);
        }

        // The signed balance — the number of record (fixture's own comment).
        const balance = await ledgerRepo.chainBalance(orgId, db, leaseRow.chainId, '2030-01-01');
        expect(balance).not.toBeNull();
        expect(typeof balance!.balanceCents).toBe('number');
        expect(balance!.balanceCents).toBe(fixture.expectedBalanceCents);

        // balanceCents === outstandingCents - creditCents, EXCEPT where the
        // fixture documents it breaks (A12 — a refund exceeding everything
        // ever received, reached by bypassing the API's own guard with a raw
        // insert, exactly as the fixture's own comment says).
        const identityGap = balance!.balanceCents - (balance!.outstandingCents - balance!.creditCents);
        if (fixture.identityBreaksBy === undefined) {
          expect(identityGap).toBe(0);
        } else {
          expect(identityGap).toBe(fixture.identityBreaksBy);
        }
      });
    }
  });

  /* ======================================================================== *
   * THE FRAME TRAP — proof, not just assertion. The real function (ROWS) gets
   * fixture A9 right; a RANGE-framed version of the SAME query, run directly
   * here (never in production code), gets it wrong. Both run against the
   * SAME inserted rows.
   * ======================================================================== */

  it('ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING is load-bearing: flipping to the default RANGE frame breaks fixture A9', async () => {
    const leaseRow = await insertLease();
    const depId = await insertCharge(leaseRow.id, { dueDate: '2026-01-01', amountCents: 50000 });
    const rentId = await insertCharge(leaseRow.id, { dueDate: '2026-01-01', amountCents: 30000 });
    await insertPayment(leaseRow.id, { kind: 'payment', amountCents: 50000 });

    // The REAL repo function — ROWS frame. Must match the fixture exactly.
    const real = await ledgerRepo.allocatedCharges(orgId, db, { chainId: leaseRow.chainId });
    const realDep = real.find((r) => r.id === depId)!;
    const realRent = real.find((r) => r.id === rentId)!;
    expect(realDep.appliedCents).toBe(50000);
    expect(realRent.appliedCents).toBe(0);

    // The SAME query, with the frame changed from ROWS to the DEFAULT RANGE —
    // ORDER BY `due_date` alone (the natural, bug-prone shape: "order by when
    // it's due"), `prior_cents` computed the common way a running-total-minus-
    // self idiom is written. Lives ONLY in this test — never in repo/ledger.ts
    // — so there is still exactly one allocation implementation in production
    // code. Confirmed against this exact database before writing this test:
    // `inclusive_sum - own_amount` gives the deposit `prior = 30000`, matching
    // PLAN-PHASE3B.md §3's own verified finding exactly.
    const rangeRows = await db.execute(sql`
      with scoped_lease as (
        select ${lease.id} as id, ${lease.chainId} as chain_id
        from ${lease}
        where ${lease.orgId} = ${orgId} and ${lease.chainId} = ${leaseRow.chainId}
      ),
      net_paid as (
        select sl.chain_id,
               coalesce(sum(case when ${payment.kind} = 'payment' then ${payment.amountCents} else -${payment.amountCents} end), 0)::bigint as total_cents
        from scoped_lease sl
        join ${payment} on ${payment.leaseId} = sl.id and ${payment.orgId} = ${orgId} and ${payment.voidedAt} is null
        group by sl.chain_id
      ),
      ordered as (
        select ${charge.id} as id,
               (sum(${charge.amountCents}) over (
                 partition by sl.chain_id
                 order by ${charge.dueDate}
                 range between unbounded preceding and current row
               ) - ${charge.amountCents})::bigint as prior_cents
        from ${charge}
        join scoped_lease sl on sl.id = ${charge.leaseId}
        where ${charge.orgId} = ${orgId} and ${charge.voidedAt} is null
      )
      select ${charge.id} as id,
             greatest(0::bigint, least(${charge.amountCents}, coalesce(np.total_cents, 0::bigint) - coalesce(o.prior_cents, 0::bigint)))::bigint as applied_cents
      from ${charge}
      join scoped_lease sl on sl.id = ${charge.leaseId}
      left join ordered o on o.id = ${charge.id}
      left join net_paid np on np.chain_id = sl.chain_id
      where ${charge.orgId} = ${orgId}
      order by ${charge.dueDate}, ${charge.id}
    `);

    const rangeById = new Map((rangeRows as unknown as { rows: { id: string; applied_cents: string }[] }).rows.map((r) => [r.id, Number(r.applied_cents)]));
    // The bug: under RANGE with `ORDER BY due_date` alone, the deposit and the
    // rent are PEERS (same due_date), so EVERY peer sees the SAME inclusive sum
    // (80000) — the deposit's own `prior_cents` comes out as 80000 - 50000 =
    // 30000 instead of the correct 0, and the $50,000 payment is misapplied:
    // only $20,000 reaches the deposit instead of the full $50,000.
    expect(rangeById.get(depId)).not.toBe(50000); // WRONG — the real function gets 50000
    expect(rangeById.get(depId)).toBe(20000); // the misapplication, concretely
  });

  /* ======================================================================== *
   * chain allocation across a renewal — a payment on the NEW lease clears a
   * debt on the OLD one. Real two-lease chain, not just fixture numbers.
   * ======================================================================== */

  it('a payment recorded on the renewed lease clears the predecessor lease\'s shortfall first', async () => {
    const oldLease = await insertLease({ startDate: '2026-01-01', endDate: '2026-03-31', status: 'ended' });
    const newLease = await insertLease({
      startDate: '2026-04-01',
      chainId: oldLease.chainId,
      renewedFromLeaseId: oldLease.id,
    });

    const oldChargeId = await insertCharge(oldLease.id, { dueDate: '2026-01-01', amountCents: 100000 });
    const newChargeId = await insertCharge(newLease.id, { dueDate: '2026-04-01', amountCents: 120000 });
    // Recorded against the NEW lease — "it does not matter which lease in a
    // chain a payment is recorded against" (§3.1).
    await insertPayment(newLease.id, { kind: 'payment', amountCents: 100000, receivedOn: '2026-04-05' });

    const rows = await ledgerRepo.allocatedCharges(orgId, db, { chainId: oldLease.chainId });
    const oldRow = rows.find((r) => r.id === oldChargeId)!;
    const newRow = rows.find((r) => r.id === newChargeId)!;
    expect(oldRow.appliedCents).toBe(100000); // the OLD lease's charge clears first
    expect(newRow.appliedCents).toBe(0); // nothing left for the new rent yet
    expect(oldRow.leaseId).toBe(oldLease.id);
    expect(newRow.leaseId).toBe(newLease.id);
  });

  /* ======================================================================== *
   * arrears — excludes not-yet-due, excludes deposits, excludes zero-amount
   * ======================================================================== */

  describe('orgArrears', () => {
    it('excludes a charge that is not yet due, excludes the deposit bucket, and never lists a zero-amount charge', async () => {
      const leaseRow = await insertLease();
      await db.insert(leaseTenant).values({
        id: uuidv7(),
        orgId,
        leaseId: leaseRow.id,
        tenantId: tenantAId,
        isPrimary: true,
        addedOn: '2020-01-01',
      });

      // Overdue, unpaid rent — the one row that SHOULD appear.
      await insertCharge(leaseRow.id, { dueDate: '2020-02-01', amountCents: 100000, type: 'rent' });
      // Not yet due — billed today for a period that has not arrived.
      await insertCharge(leaseRow.id, { dueDate: '2099-01-01', amountCents: 100000, type: 'rent' });
      // An unpaid DEPOSIT, overdue by date — must never count as arrears.
      await insertCharge(leaseRow.id, { dueDate: '2020-01-01', amountCents: 200000, type: 'deposit' });
      // A zero-amount rent charge, overdue by date — born paid (§3.5 rule 2),
      // never arrears no matter how late the calendar says it is.
      await insertCharge(leaseRow.id, { dueDate: '2020-01-01', amountCents: 0, type: 'rent' });

      const { rows } = await ledgerRepo.orgArrears(orgId, db, { minCents: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.arrearsCents).toBe(100000);
      expect(rows[0]!.oldestOverdueDueDate).toBe('2020-02-01');
    });
  });

  /* ======================================================================== *
   * the deposit-return recipe (§4.9) — void the deposit charge, refund the
   * money, net to EXACTLY zero without reopening prior rent.
   * ======================================================================== */

  it('deposit-return recipe: void the deposit charge + refund nets to zero, never reopens the paid rent', async () => {
    const leaseRow = await insertLease();
    const depositId = await insertCharge(leaseRow.id, { dueDate: '2020-01-01', amountCents: 200000, type: 'deposit' });
    const rentId = await insertCharge(leaseRow.id, { dueDate: '2020-02-01', amountCents: 100000, type: 'rent' });
    // One payment covering both in full.
    await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
      kind: 'payment',
      method: 'bank_transfer',
      amountCents: 300000,
      receivedOn: '2020-02-01',
    });

    const before = await ledgerRepo.chainBalance(orgId, db, leaseRow.chainId, '2030-01-01');
    expect(before!.balanceCents).toBe(0);

    // The recipe: void the deposit charge, then refund it.
    await chargeRepo.voidCharge(orgId, db, leaseRow.id, depositId, userId, {
      reason: 'Deposit returned at move-out.',
    });
    await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
      kind: 'refund',
      method: 'bank_transfer',
      amountCents: 200000,
      // Must be safely in the PAST relative to the real wall clock —
      // `recordPayment` validates `receivedOn` against `localToday`, which
      // reads the actual current date, not this test's fictional timeline.
      receivedOn: '2020-03-01',
    });

    const after = await ledgerRepo.chainBalance(orgId, db, leaseRow.chainId, '2030-01-01');
    expect(after!.balanceCents).toBe(0); // nets to EXACTLY zero
    expect(after!.depositOutstandingCents).toBe(0);

    const rows = await ledgerRepo.allocatedCharges(orgId, db, { chainId: leaseRow.chainId });
    const rentRow = rows.find((r) => r.id === rentId)!;
    // The rent charge is UNTOUCHED — still fully applied, never reopened by
    // the refund (a bare refund would have retreated FIFO from the newest
    // charge backwards and made this read unpaid).
    expect(rentRow.appliedCents).toBe(100000);
  });

  /* ======================================================================== *
   * cross-org isolation — every new ledger function, proven against real rows
   * ======================================================================== */

  describe('cross-org isolation', () => {
    it("org B's allocatedCharges for org A's chainId returns nothing", async () => {
      const leaseRow = await insertLease();
      await insertCharge(leaseRow.id, { dueDate: '2020-01-01', amountCents: 1000 });

      const rows = await ledgerRepo.allocatedCharges(otherOrgId, db, { chainId: leaseRow.chainId });
      expect(rows).toHaveLength(0);
    });

    it("org B's chainBalance for org A's chainId is null", async () => {
      const leaseRow = await insertLease();
      await insertCharge(leaseRow.id, { dueDate: '2020-01-01', amountCents: 1000 });

      const result = await ledgerRepo.chainBalance(otherOrgId, db, leaseRow.chainId, '2026-01-01');
      expect(result).toBeNull();
    });

    it("org B's leaseAndChainBalance for org A's leaseId is null", async () => {
      const leaseRow = await insertLease();
      const result = await ledgerRepo.leaseAndChainBalance(otherOrgId, db, leaseRow.id, '2026-01-01');
      expect(result).toBeNull();
    });

    it("org B's leaseLedger for org A's leaseId is null", async () => {
      const leaseRow = await insertLease();
      const result = await ledgerRepo.leaseLedger(otherOrgId, db, leaseRow.id, '2026-01-01', { includeVoided: true });
      expect(result).toBeNull();
    });

    it("org B's orgArrears never includes org A's chains", async () => {
      const leaseRow = await insertLease();
      await db.insert(leaseTenant).values({
        id: uuidv7(),
        orgId,
        leaseId: leaseRow.id,
        tenantId: tenantAId,
        isPrimary: true,
        addedOn: '2020-01-01',
      });
      await insertCharge(leaseRow.id, { dueDate: '2020-01-01', amountCents: 100000, type: 'rent' });

      const { rows } = await ledgerRepo.orgArrears(otherOrgId, db, { minCents: 1 });
      expect(rows).toHaveLength(0);
    });
  });
});
