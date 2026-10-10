import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@rms/contract';
import { createDb, type Database } from '../index.js';
import { organization, user, property, unit, lease, charge, payment } from '../schema.js';
import * as unitRepo from './unit.js';
import * as propertyRepo from './property.js';
import * as paymentRepo from './payment.js';

/**
 * REAL orchestration-function tests for `repo/payment.ts`, against REAL
 * Postgres — the guard clauses (draft/cancelled lease, future-dated receivedOn,
 * the refund guard, the symmetric void guard) cannot be proven from an
 * un-executed `.toSQL()` AST (see payment.test.ts for that half).
 *
 * SKIPPED ENTIRELY when `DATABASE_URL` is unset — `pnpm --filter api test:live`
 * from the repo root runs this for real.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('payment.ts orchestration functions — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let propertyId: string;
  let unitId: string;

  beforeAll(() => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
  });

  beforeEach(async () => {
    orgId = `itest_org_${uuidv7()}`;
    otherOrgId = `itest_org_other_${uuidv7()}`;
    userId = `itest_user_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'Payment Test Org', slug: orgId });
    await db.insert(organization).values({ id: otherOrgId, name: 'Payment Test Org (other)', slug: otherOrgId });
    await db.insert(user).values({ id: userId, name: 'Payment Test User', email: `${userId}@example.test` });

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
  });

  afterEach(async () => {
    for (const org of [orgId, otherOrgId]) {
      await db.delete(payment).where(eq(payment.orgId, org));
      await db.delete(charge).where(eq(charge.orgId, org));
      await db.delete(lease).where(eq(lease.orgId, org));
      await db.delete(unit).where(eq(unit.orgId, org));
      await db.delete(property).where(eq(property.orgId, org));
      await db.delete(organization).where(eq(organization.id, org));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  async function insertLease(overrides: Partial<typeof lease.$inferInsert> = {}) {
    const id = uuidv7();
    const row: typeof lease.$inferInsert = {
      id,
      orgId,
      unitId,
      chainId: id,
      startDate: '2020-01-01',
      endDate: null,
      rentCents: 100000,
      currency: 'USD',
      rentFrequency: 'monthly',
      billingDay: 1,
      depositCents: 0,
      openingBalanceCents: 0,
      ledgerStartDate: '2020-01-01',
      status: 'active',
      createdByUserId: userId,
      ...overrides,
    };
    await db.insert(lease).values(row);
    return row;
  }

  const basePayment = () =>
    ({
      kind: 'payment' as const,
      method: 'bank_transfer' as const,
      amountCents: 100000,
      receivedOn: '2020-06-01',
    });

  /* ======================================================================== *
   * recordPayment
   * ======================================================================== */

  describe('recordPayment', () => {
    it('writes a payment with the LEASE currency, never a client-supplied one', async () => {
      const leaseRow = await insertLease({ currency: 'GBP' });
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      expect(created?.currency).toBe('GBP');
      expect(created?.recordedByUserId).toBe(userId);
      expect(created?.voidedAt).toBeNull();
    });

    it('refuses a draft lease (409)', async () => {
      const leaseRow = await insertLease({ status: 'draft' });
      await expect(paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment())).rejects.toMatchObject({
        code: 'conflict',
      });
    });

    it('refuses a cancelled lease (409)', async () => {
      const leaseRow = await insertLease({ status: 'cancelled' });
      await expect(paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment())).rejects.toMatchObject({
        code: 'conflict',
      });
    });

    it('a future-dated receivedOn 422s, naming the field', async () => {
      const leaseRow = await insertLease();
      const farFuture = '2099-01-01';
      await expect(
        paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, { ...basePayment(), receivedOn: farFuture }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it('a receivedOn predating the lease startDate is allowed — a deposit paid at signing', async () => {
      const leaseRow = await insertLease({ startDate: '2026-06-01', ledgerStartDate: '2026-06-01' });
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
        ...basePayment(),
        receivedOn: '2020-01-01',
      });
      expect(created).not.toBeNull();
    });

    it('a refund larger than everything ever received 409s (§4.14)', async () => {
      const leaseRow = await insertLease();
      await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, { ...basePayment(), amountCents: 50000 });
      await expect(
        paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
          kind: 'refund',
          method: 'bank_transfer',
          amountCents: 80000,
          receivedOn: '2020-06-02',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('a refund exactly equal to net received is allowed — right up to the edge', async () => {
      const leaseRow = await insertLease();
      await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, { ...basePayment(), amountCents: 50000 });
      const refund = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
        kind: 'refund',
        method: 'bank_transfer',
        amountCents: 50000,
        receivedOn: '2020-06-02',
      });
      expect(refund).not.toBeNull();
    });

    /**
     * `payment_amount_ck` (`amount_cents > 0`) is unreachable through the
     * CONTRACT — `paymentAmountCents` already refines `> 0` — but the repo
     * function itself takes no TS-level stop against a caller bypassing that
     * (e.g. a future internal caller, a script). This proves the belt-and-
     * -suspenders actually works: the real CHECK fires, `isCheckViolation`
     * recognises SQLSTATE 23514, and the repo turns it into a 422 naming the
     * field rather than an unhandled 500 (PLAN-PHASE3B.md §2.4).
     */
    it('a zero amountCents that bypasses the contract hits payment_amount_ck, which the repo turns into a 422', async () => {
      const leaseRow = await insertLease();
      await expect(
        paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, { ...basePayment(), amountCents: 0 }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });

    it("cross-org: org B's recordPayment for org A's lease id returns null, writes nothing", async () => {
      const leaseRow = await insertLease();
      const result = await paymentRepo.recordPayment(otherOrgId, db, leaseRow.id, userId, basePayment());
      expect(result).toBeNull();

      const rows = await db.select().from(payment).where(eq(payment.leaseId, leaseRow.id));
      expect(rows).toHaveLength(0);
    });
  });

  /* ======================================================================== *
   * updatePaymentNote — the only mutable field
   * ======================================================================== */

  describe('updatePaymentNote', () => {
    it('updates note and nothing else', async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      const updated = await paymentRepo.updatePaymentNote(orgId, db, leaseRow.id, created!.id, 'Paid in person.');
      expect(updated?.note).toBe('Paid in person.');
      expect(updated?.amountCents).toBe(created!.amountCents);
    });

    it("cross-org: org B's updatePaymentNote for org A's payment returns null", async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      const updated = await paymentRepo.updatePaymentNote(otherOrgId, db, leaseRow.id, created!.id, 'Should not land.');
      expect(updated).toBeNull();
    });
  });

  /* ======================================================================== *
   * voidPayment
   * ======================================================================== */

  describe('voidPayment', () => {
    it('sets voidedAt/voidedReason/voidedByUserId exactly once', async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      const voided = await paymentRepo.voidPayment(orgId, db, leaseRow.id, created!.id, userId, {
        reason: 'Cheque bounced at the bank.',
      });
      expect(voided?.voidedAt).not.toBeNull();
      expect(voided?.voidedReason).toBe('Cheque bounced at the bank.');
    });

    it('voiding an already-voided payment 409s', async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      await paymentRepo.voidPayment(orgId, db, leaseRow.id, created!.id, userId, { reason: 'Bounced cheque.' });
      await expect(
        paymentRepo.voidPayment(orgId, db, leaseRow.id, created!.id, userId, { reason: 'Bounced cheque again?' }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    /**
     * THE decision this agent made beyond the plan (see final report): voiding
     * an original PAYMENT is guarded symmetrically to the refund guard — fixture
     * A12's exact scenario, reached through the real API this time: refund right
     * up to the edge of net-received (guarded, passes), then void the original
     * payment that created the room for it. Without this guard, net-received
     * would go negative with nothing in the way.
     */
    it('voiding a payment that would take net-received below zero (after a refund already spent the room) 409s', async () => {
      const leaseRow = await insertLease();
      const original = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
        ...basePayment(),
        amountCents: 50000,
      });
      await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
        kind: 'refund',
        method: 'bank_transfer',
        amountCents: 50000,
        receivedOn: '2020-06-02',
      });
      // Net received is now exactly 0. Voiding the original $50,000 payment
      // would take it to -50,000 — refused, where an unguarded void would have
      // let it through.
      await expect(
        paymentRepo.voidPayment(orgId, db, leaseRow.id, original!.id, userId, {
          reason: 'Trying to void after the refund already spent the room.',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('voiding a REFUND is always allowed — it can only increase net-received, never push it negative', async () => {
      const leaseRow = await insertLease();
      await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, { ...basePayment(), amountCents: 50000 });
      const refund = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
        kind: 'refund',
        method: 'bank_transfer',
        amountCents: 50000,
        receivedOn: '2020-06-02',
      });
      const voided = await paymentRepo.voidPayment(orgId, db, leaseRow.id, refund!.id, userId, {
        reason: 'Refund was recorded in error.',
      });
      expect(voided?.voidedAt).not.toBeNull();
    });

    it("cross-org: org B's voidPayment for org A's (lease, payment) returns null, never reaching the UPDATE", async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      const result = await paymentRepo.voidPayment(otherOrgId, db, leaseRow.id, created!.id, userId, {
        reason: 'Should never apply — wrong org entirely.',
      });
      expect(result).toBeNull();

      const stillLive = await paymentRepo.resolvePayment(orgId, db, leaseRow.id, created!.id);
      expect(stillLive?.voidedAt).toBeNull();
    });
  });

  /* ======================================================================== *
   * correctPayment — void the original, insert a successor
   * ======================================================================== */

  describe('correctPayment', () => {
    it('voids the original and inserts a successor linked to it', async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, {
        ...basePayment(),
        amountCents: 120000,
      });
      const corrected = await paymentRepo.correctPayment(orgId, db, leaseRow.id, created!.id, userId, {
        ...basePayment(),
        amountCents: 102000,
        reason: 'Recorded the wrong amount — it was $1,020, not $1,200.',
      });
      expect(corrected?.amountCents).toBe(102000);
      expect(corrected?.supersedesPaymentId).toBe(created!.id);

      const original = await paymentRepo.resolvePayment(orgId, db, leaseRow.id, created!.id);
      expect(original?.voidedAt).not.toBeNull();
    });

    it('correcting an already-voided payment 409s', async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      await paymentRepo.voidPayment(orgId, db, leaseRow.id, created!.id, userId, { reason: 'Bounced cheque.' });
      await expect(
        paymentRepo.correctPayment(orgId, db, leaseRow.id, created!.id, userId, {
          ...basePayment(),
          reason: 'Trying to correct an already-voided payment.',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it("cross-org: org B's correctPayment for org A's (lease, payment) returns null, writes nothing", async () => {
      const leaseRow = await insertLease();
      const created = await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());
      const result = await paymentRepo.correctPayment(otherOrgId, db, leaseRow.id, created!.id, userId, {
        ...basePayment(),
        reason: 'Should never apply — wrong org entirely.',
      });
      expect(result).toBeNull();

      const rows = await db.select().from(payment).where(eq(payment.leaseId, leaseRow.id));
      expect(rows).toHaveLength(1); // only the original — no successor written
      expect(rows[0]!.voidedAt).toBeNull(); // and it was never voided either
    });
  });

  /* ======================================================================== *
   * listPayments / resolvePayment / existsPaymentForLease — cross-org isolation
   * ======================================================================== */

  describe('listPayments / resolvePayment / existsPaymentForLease — cross-org isolation', () => {
    it("org B's listPayments for org A's lease id returns an empty page, never org A's rows", async () => {
      const leaseRow = await insertLease();
      await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());

      const { rows, hasMore } = await paymentRepo.listPayments(otherOrgId, db, leaseRow.id, {
        limit: 25,
        includeVoided: true,
      });
      expect(rows).toHaveLength(0);
      expect(hasMore).toBe(false);
    });

    it("org B's existsPaymentForLease for org A's lease id is false even though a payment exists", async () => {
      const leaseRow = await insertLease();
      await paymentRepo.recordPayment(orgId, db, leaseRow.id, userId, basePayment());

      expect(await paymentRepo.existsPaymentForLease(orgId, db, leaseRow.id)).toBe(true);
      expect(await paymentRepo.existsPaymentForLease(otherOrgId, db, leaseRow.id)).toBe(false);
    });
  });
});
