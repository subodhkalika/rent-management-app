import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@rms/contract';
import { createDb, type Database } from '../index.js';
import { organization, user, property, unit, lease, charge } from '../schema.js';
import * as chargeRepo from './charge.js';
import * as propertyRepo from './property.js';
import * as unitRepo from './unit.js';

/**
 * REAL orchestration-function tests for `repo/charge.ts`, against REAL Postgres —
 * the idempotency/catch-up/void/correction semantics (PLAN-PHASE3A.md §4) cannot
 * be proven from an un-executed `.toSQL()` AST (see `charge.test.ts` for that
 * half: the query-builder shape and org scoping).
 *
 * SKIPPED ENTIRELY when `DATABASE_URL` is unset — see lease.integration.test.ts's
 * own comment for how to run this for real.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('charge.ts orchestration functions — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let propertyId: string;
  let unitId: string;

  const baseLease = (overrides: Partial<typeof lease.$inferInsert> = {}): typeof lease.$inferInsert => {
    const id = uuidv7();
    return {
      id,
      orgId,
      unitId,
      chainId: id,
      startDate: '2026-01-01',
      endDate: null,
      rentCents: 100000,
      currency: 'USD',
      rentFrequency: 'monthly',
      billingDay: 1,
      depositCents: 0,
      openingBalanceCents: 0,
      ledgerStartDate: '2026-01-01',
      status: 'active',
      createdByUserId: userId,
      ...overrides,
    };
  };

  const generatableLeaseFrom = (row: typeof lease.$inferInsert): chargeRepo.GeneratableLease => ({
    id: row.id as string,
    currency: row.currency as string,
    rentFrequency: row.rentFrequency as chargeRepo.GeneratableLease['rentFrequency'],
    rentCents: row.rentCents as number,
    billingDay: row.billingDay as number,
    startDate: row.startDate as string,
    endDate: (row.endDate as string | null) ?? null,
    ledgerStartDate: row.ledgerStartDate as string,
    moveOutDate: (row.moveOutDate as string | null) ?? null,
    moveOutBillingPolicy: 'bill_full_term',
    calendar: 'gregorian',
    depositCents: (row.depositCents as number) ?? 0,
    openingBalanceCents: (row.openingBalanceCents as number) ?? 0,
  });

  async function insertLease(overrides: Partial<typeof lease.$inferInsert> = {}) {
    const row = baseLease(overrides);
    await db.insert(lease).values(row);
    return row;
  }

  beforeAll(() => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
  });

  beforeEach(async () => {
    orgId = `itest_org_${uuidv7()}`;
    otherOrgId = `itest_org_other_${uuidv7()}`;
    userId = `itest_user_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'Charge Test Org', slug: orgId });
    await db.insert(organization).values({ id: otherOrgId, name: 'Charge Test Org (other)', slug: otherOrgId });
    await db.insert(user).values({ id: userId, name: 'Charge Test User', email: `${userId}@example.test` });

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
      status: 'occupied',
    });
    unitId = unitRow.id;
  });

  afterEach(async () => {
    for (const org of [orgId, otherOrgId]) {
      await db.delete(charge).where(eq(charge.orgId, org));
      await db.delete(lease).where(eq(lease.orgId, org));
      await db.delete(unit).where(eq(unit.orgId, org));
      await db.delete(property).where(eq(property.orgId, org));
      await db.delete(organization).where(eq(organization.id, org));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  /* ======================================================================== *
   * generateChargesForLease — idempotency, catch-up, void-then-regenerate
   * ======================================================================== */

  describe('generateChargesForLease', () => {
    it('idempotency: running twice with the same today inserts nothing the second time', async () => {
      const row = await insertLease();
      const gLease = generatableLeaseFrom(row);

      const first = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-02-01');
      expect(first.length).toBeGreaterThan(0);

      const second = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-02-01');
      expect(second).toEqual([]);

      const rows = await db.select().from(charge).where(eq(charge.leaseId, row.id as string));
      expect(rows).toHaveLength(first.length);
    });

    it('catch-up: advancing today by 40 days with no intervening run backfills exactly the missing periods, with correct historical due dates, zero duplicates', async () => {
      const row = await insertLease();
      const gLease = generatableLeaseFrom(row);

      const day1 = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-01-05');
      const keysAfterDay1 = day1.map((c) => c.generationKey).sort();

      const day41 = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-02-14'); // +40 days
      const keysAfterDay41 = day41.map((c) => c.generationKey).sort();

      // Nothing written on day 1 is written again on day 41.
      expect(keysAfterDay1.some((k) => keysAfterDay41.includes(k))).toBe(false);

      const allRows = await db
        .select()
        .from(charge)
        .where(eq(charge.leaseId, row.id as string))
        .orderBy(asc(charge.periodStart));
      const keys = allRows.map((r) => r.generationKey);
      expect(new Set(keys).size).toBe(keys.length); // zero duplicates

      // Every row's due date is still DERIVED FROM ITS OWN PERIOD, never from
      // "today" — the March row due date must equal what a single run at the
      // March period's own start would have produced (billingDay=1 => due on
      // the 1st of its own month).
      const march = allRows.find((r) => r.periodStart === '2026-03-01');
      expect(march?.dueDate).toBe('2026-03-01');
    });

    it('void-then-regenerate: voiding a generated charge and re-running the generator writes NOTHING for that period ever again', async () => {
      const row = await insertLease();
      const gLease = generatableLeaseFrom(row);

      const created = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-03-01');
      const march = created.find((c) => c.generationKey === '2026-03-01')!;
      expect(march).toBeDefined();

      const voided = await chargeRepo.voidCharge(orgId, db, row.id as string, march.id, userId, {
        reason: 'Landlord error — duplicate charge.',
      });
      expect(voided?.voidedAt).not.toBeNull();

      // Re-run at the SAME today, and again much later — the voided key must
      // never be recreated, by construction of the plain (not partial)
      // charge_generation_uq index (PLAN-PHASE3A.md §7.1).
      await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-03-01');
      await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-06-01');

      const marchRows = await db
        .select()
        .from(charge)
        .where(and(eq(charge.leaseId, row.id as string), eq(charge.generationKey, '2026-03-01')));
      expect(marchRows).toHaveLength(1);
      expect(marchRows[0]?.voidedAt).not.toBeNull();
    });

    it('a correction keeps generation_key = NULL, so a later run writes nothing for the corrected period', async () => {
      const row = await insertLease();
      const gLease = generatableLeaseFrom(row);

      const created = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-02-01');
      const jan = created.find((c) => c.generationKey === '2026-01-01')!;

      const corrected = await chargeRepo.correctCharge(orgId, db, row.id as string, jan.id, userId, {
        amountCents: 90000,
        reason: 'Agreed a $100 discount for January.',
      });
      expect(corrected?.generationKey).toBeNull();
      expect(corrected?.source).toBe('manual');
      expect(corrected?.supersedesChargeId).toBe(jan.id);

      await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-02-01');

      const janRows = await db
        .select()
        .from(charge)
        .where(and(eq(charge.leaseId, row.id as string), eq(charge.generationKey, '2026-01-01')));
      expect(janRows).toHaveLength(1); // the original, voided — never a second one
      expect(janRows[0]?.voidedAt).not.toBeNull();

      const successorRows = await db
        .select()
        .from(charge)
        .where(and(eq(charge.leaseId, row.id as string), eq(charge.supersedesChargeId, jan.id)));
      expect(successorRows).toHaveLength(1);
      expect(successorRows[0]?.amountCents).toBe(90000);
    });

    it('a zero-amount rent period IS written — the period exists, so the ledger must show it (§1.5)', async () => {
      // rentCents=1, a 1-day occupied window in a 31-day period rounds to 0.
      const row = await insertLease({ startDate: '2026-01-31', ledgerStartDate: '2026-01-31', rentCents: 1 });
      const gLease = generatableLeaseFrom(row);

      const created = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-02-01');
      const jan = created.find((c) => c.generationKey === '2026-01-01');
      expect(jan).toBeDefined();
      expect(jan?.amountCents).toBe(0);
      expect(jan?.isProrated).toBe(true);
    });

    it('a zero deposit and a zero opening balance write NOTHING — absence, not an obligation', async () => {
      const row = await insertLease({ depositCents: 0, openingBalanceCents: 0 });
      const gLease = generatableLeaseFrom(row);

      const created = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-01-05');
      expect(created.some((c) => c.type === 'deposit')).toBe(false);
      expect(created.some((c) => c.type === 'opening_balance')).toBe(false);
    });

    it('a positive deposit writes ONE charge, due on startDate, keyed "deposit"', async () => {
      const row = await insertLease({ depositCents: 150000 });
      const gLease = generatableLeaseFrom(row);

      const created = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-01-05');
      const deposit = created.find((c) => c.type === 'deposit');
      expect(deposit).toBeDefined();
      expect(deposit?.generationKey).toBe('deposit');
      expect(deposit?.dueDate).toBe(row.startDate);
      expect(deposit?.amountCents).toBe(150000);
      expect(deposit?.source).toBe('generated');
      expect(deposit?.createdByUserId).toBeNull();

      // Running again writes zero more — the same plain unique index.
      const second = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-01-06');
      expect(second.some((c) => c.type === 'deposit')).toBe(false);
    });

    it('every written row carries the CALLER\'s orgId — the argument, never anything inferred', async () => {
      const row = await insertLease();
      const gLease = generatableLeaseFrom(row);

      await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-01-05');
      const rows = await db.select().from(charge).where(eq(charge.leaseId, row.id as string));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.orgId === orgId)).toBe(true);
    });
  });

  /* ======================================================================== *
   * rentStepMutabilityBoundary — PLAN-PHASE3A.md §3.4
   * ======================================================================== */

  describe('rentStepMutabilityBoundary', () => {
    it('equals today when nothing has been generated yet', async () => {
      const row = await insertLease();
      const boundary = await chargeRepo.rentStepMutabilityBoundary(orgId, db, row.id as string, '2026-01-15');
      expect(boundary).toBe('2026-01-15');
    });

    it('equals the latest GENERATED rent period start when that is later than today', async () => {
      const row = await insertLease();
      const gLease = generatableLeaseFrom(row);
      // 31-day lookahead from 2026-01-05 reaches into February.
      await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-01-05');

      const boundary = await chargeRepo.rentStepMutabilityBoundary(orgId, db, row.id as string, '2026-01-05');
      expect(boundary).toBe('2026-02-01'); // the lookahead already wrote February
    });

    /**
     * Review decision (2026-10-09), overriding an earlier version of this test
     * that asserted the opposite: a VOIDED period must still count toward the
     * boundary — the boundary is MONOTONIC, never retreating. Before this fix,
     * voiding the latest-billed period (February here) dropped the boundary back
     * to January, and a step dated in February would then take a free `PUT` —
     * no correction audit, no reason required — while `charge_generation_uq`
     * still held February's key (so nothing regenerates) and the drift banner
     * stayed silent (the key is occupied, not missing). The ladder would say one
     * number, the bill another, and nothing would tell anyone.
     */
    it('a VOIDED rent period still counts toward the boundary — once billed, always billed (monotonic)', async () => {
      const row = await insertLease();
      const gLease = generatableLeaseFrom(row);
      const created = await chargeRepo.generateChargesForLease(orgId, db, gLease, [], '2026-01-05');
      const feb = created.find((c) => c.generationKey === '2026-02-01')!;

      const beforeVoid = await chargeRepo.rentStepMutabilityBoundary(orgId, db, row.id as string, '2026-01-20');
      expect(beforeVoid).toBe('2026-02-01');

      await chargeRepo.voidCharge(orgId, db, row.id as string, feb.id, userId, { reason: 'Voided for this test.' });

      const afterVoid = await chargeRepo.rentStepMutabilityBoundary(orgId, db, row.id as string, '2026-01-20');
      expect(afterVoid).toBe('2026-02-01'); // UNCHANGED — the boundary never retreats
    });
  });

  /* ======================================================================== *
   * manual charges — create / void / correct
   * ======================================================================== */

  describe('createManualCharge', () => {
    it('writes a manual charge with the lease currency, source=manual, generationKey=null', async () => {
      const row = await insertLease();
      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'late_fee',
        amountCents: 5000,
        dueDate: '2026-01-15',
      });
      expect(created?.source).toBe('manual');
      expect(created?.generationKey).toBeNull();
      expect(created?.currency).toBe('USD');
      expect(created?.createdByUserId).toBe(userId);
    });

    it('refuses a draft lease (409) — §3.5\'s hardDeleteLease invariant holds by construction', async () => {
      const row = await insertLease({ status: 'draft' });
      await expect(
        chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
          type: 'late_fee',
          amountCents: 5000,
          dueDate: '2026-01-15',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('refuses a cancelled lease (409)', async () => {
      const row = await insertLease({ status: 'cancelled' });
      await expect(
        chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
          type: 'late_fee',
          amountCents: 5000,
          dueDate: '2026-01-15',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it("cross-org: org B's createManualCharge for org A's lease id returns null, writes nothing", async () => {
      const row = await insertLease();
      const result = await chargeRepo.createManualCharge(otherOrgId, db, row.id as string, userId, {
        type: 'late_fee',
        amountCents: 5000,
        dueDate: '2026-01-15',
      });
      expect(result).toBeNull();
      const rows = await db.select().from(charge).where(eq(charge.leaseId, row.id as string));
      expect(rows).toHaveLength(0);
    });
  });

  describe('voidCharge', () => {
    it('sets voidedAt/voidedReason/voidedByUserId exactly once', async () => {
      const row = await insertLease();
      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 3000,
        dueDate: '2026-01-10',
      });
      const voided = await chargeRepo.voidCharge(orgId, db, row.id as string, created!.id, userId, {
        reason: 'Charged in error — duplicate utility bill.',
      });
      expect(voided?.voidedAt).not.toBeNull();
      expect(voided?.voidedReason).toBe('Charged in error — duplicate utility bill.');
    });

    it('voiding an already-voided charge 409s', async () => {
      const row = await insertLease();
      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 3000,
        dueDate: '2026-01-10',
      });
      await chargeRepo.voidCharge(orgId, db, row.id as string, created!.id, userId, { reason: 'First void, legit.' });
      await expect(
        chargeRepo.voidCharge(orgId, db, row.id as string, created!.id, userId, { reason: 'Second void attempt.' }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it("cross-org: org B's voidCharge for org A's (lease, charge) returns null, never reaching the UPDATE", async () => {
      const row = await insertLease();
      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 3000,
        dueDate: '2026-01-10',
      });
      const result = await chargeRepo.voidCharge(otherOrgId, db, row.id as string, created!.id, userId, {
        reason: 'Should never apply — wrong org entirely.',
      });
      expect(result).toBeNull();
      const stillLive = await chargeRepo.resolveCharge(orgId, db, row.id as string, created!.id);
      expect(stillLive?.voidedAt).toBeNull();
    });
  });

  describe('correctCharge', () => {
    it('voids the original and inserts a successor linked to it, source=manual, generationKey=null', async () => {
      const row = await insertLease();
      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 3000,
        dueDate: '2026-01-10',
      });
      const corrected = await chargeRepo.correctCharge(orgId, db, row.id as string, created!.id, userId, {
        amountCents: 2500,
        reason: 'Tenant provided a corrected utility invoice.',
      });
      expect(corrected?.amountCents).toBe(2500);
      expect(corrected?.supersedesChargeId).toBe(created!.id);
      expect(corrected?.source).toBe('manual');
      expect(corrected?.generationKey).toBeNull();

      const original = await chargeRepo.resolveCharge(orgId, db, row.id as string, created!.id);
      expect(original?.voidedAt).not.toBeNull();
    });

    it('correcting an already-voided charge 409s', async () => {
      const row = await insertLease();
      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 3000,
        dueDate: '2026-01-10',
      });
      await chargeRepo.voidCharge(orgId, db, row.id as string, created!.id, userId, { reason: 'Voided first.' });
      await expect(
        chargeRepo.correctCharge(orgId, db, row.id as string, created!.id, userId, {
          amountCents: 1000,
          reason: 'Should never apply — already voided.',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it("cross-org: org B's correctCharge for org A's (lease, charge) returns null, writes nothing", async () => {
      const row = await insertLease();
      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 3000,
        dueDate: '2026-01-10',
      });
      const result = await chargeRepo.correctCharge(otherOrgId, db, row.id as string, created!.id, userId, {
        amountCents: 1,
        reason: 'Should never apply — wrong org entirely.',
      });
      expect(result).toBeNull();
      const rows = await db.select().from(charge).where(eq(charge.leaseId, row.id as string));
      expect(rows).toHaveLength(1); // only the original — no successor was written
    });
  });

  /* ======================================================================== *
   * existsChargeForLease — hardDeleteLease's zero-charge precondition
   * ======================================================================== */

  describe('existsChargeForLease', () => {
    it('false before any charge, true after — voided or not', async () => {
      const row = await insertLease();
      expect(await chargeRepo.existsChargeForLease(orgId, db, row.id as string)).toBe(false);

      const created = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 100,
        dueDate: '2026-01-10',
      });
      expect(await chargeRepo.existsChargeForLease(orgId, db, row.id as string)).toBe(true);

      await chargeRepo.voidCharge(orgId, db, row.id as string, created!.id, userId, { reason: 'Voided, still counts.' });
      expect(await chargeRepo.existsChargeForLease(orgId, db, row.id as string)).toBe(true);
    });

    it("cross-org: org B's existsChargeForLease for org A's lease id is false even though a charge exists", async () => {
      const row = await insertLease();
      await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'utility',
        amountCents: 100,
        dueDate: '2026-01-10',
      });
      expect(await chargeRepo.existsChargeForLease(otherOrgId, db, row.id as string)).toBe(false);
    });
  });

  /* ======================================================================== *
   * listCharges / listChargesForOrg — cross-org isolation
   * ======================================================================== */

  describe('listCharges / listChargesForOrg — cross-org isolation', () => {
    it("org B's listCharges for org A's lease id returns an empty page, never org A's rows", async () => {
      const row = await insertLease();
      await chargeRepo.generateChargesForLease(orgId, db, generatableLeaseFrom(row), [], '2026-01-05');

      const { rows } = await chargeRepo.listCharges(otherOrgId, db, row.id as string, {
        limit: 25,
        includeVoided: true,
      });
      expect(rows).toEqual([]);
    });

    it("org B's listChargesForOrg never includes org A's charges", async () => {
      const row = await insertLease();
      await chargeRepo.generateChargesForLease(orgId, db, generatableLeaseFrom(row), [], '2026-01-05');

      const { rows } = await chargeRepo.listChargesForOrg(otherOrgId, db, {
        limit: 25,
        includeVoided: true,
        overdueOnly: false,
      });
      expect(rows).toEqual([]);
    });
  });

  /**
   * Review finding 9: the `overdueOnly` SQL predicate
   * (`due_date < (now() at time zone property.timezone)::date` —
   * `listChargesForOrgQuery` in charge.ts) was asserted only as SQL TEXT
   * (`charge.test.ts`) and every integration test ran with `overdueOnly: false`
   * — the one expression with a second implementation behind it (the contract's
   * own `chargeOverdue`) had no LIVE test. This runs it for real.
   */
  describe('listChargesForOrg — overdueOnly, against REAL Postgres', () => {
    it('includes only the charge due in the clear past, excludes the one due in the clear future', async () => {
      const row = await insertLease();
      const overdue = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'late_fee',
        amountCents: 5000,
        dueDate: '2000-01-01', // unambiguously in the past, whenever this suite runs
      });
      const notYetDue = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'late_fee',
        amountCents: 5000,
        dueDate: '2099-01-01', // unambiguously in the future
      });

      const { rows: overdueOnlyRows } = await chargeRepo.listChargesForOrg(orgId, db, {
        limit: 25,
        includeVoided: true,
        overdueOnly: true,
      });
      const overdueIds = overdueOnlyRows.map((r) => r.id);
      expect(overdueIds).toContain(overdue!.id);
      expect(overdueIds).not.toContain(notYetDue!.id);

      const { rows: allRows } = await chargeRepo.listChargesForOrg(orgId, db, {
        limit: 25,
        includeVoided: true,
        overdueOnly: false,
      });
      const allIds = allRows.map((r) => r.id);
      expect(allIds).toContain(overdue!.id);
      expect(allIds).toContain(notYetDue!.id);
    });

    it('excludes a VOIDED overdue charge — voiding is a decision, not something still owed', async () => {
      const row = await insertLease();
      const overdue = await chargeRepo.createManualCharge(orgId, db, row.id as string, userId, {
        type: 'late_fee',
        amountCents: 5000,
        dueDate: '2000-01-01',
      });
      await chargeRepo.voidCharge(orgId, db, row.id as string, overdue!.id, userId, { reason: 'Charged in error.' });

      const { rows } = await chargeRepo.listChargesForOrg(orgId, db, {
        limit: 25,
        includeVoided: true,
        overdueOnly: true,
      });
      expect(rows.map((r) => r.id)).not.toContain(overdue!.id);
    });
  });
});
