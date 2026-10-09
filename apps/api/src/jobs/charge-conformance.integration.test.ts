import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  uuidv7,
  addDays,
  scheduleFixtures,
  bsScheduleFixtures,
  bsYearlyFixture,
  generationPlanFixtures,
  GENERATION_LOOKAHEAD_DAYS,
  plannedChargeFromCharge,
  type ScheduleFixture,
  type IsoDate,
} from '@rms/contract';
import { createDb, type Database } from '../db/index.js';
import { organization, user, property, unit, lease, charge } from '../db/schema.js';
import * as chargeRepo from '../db/repo/charge.js';

/**
 * THE conformance test (PLAN-PHASE3A.md §2.4) — the one this phase exists for.
 *
 * Drives every schedule fixture through the REAL generator (`generateChargesForLease`)
 * against LIVE Postgres and compares the written rows, mapped back through the
 * contract's own `plannedChargeFromCharge`, to the fixture's own UNEDITED `expected`
 * array. `today` is DERIVED from the fixture
 * (`addDays(fixture.through, -GENERATION_LOOKAHEAD_DAYS)`), never hand-chosen — so
 * the expected array is the fixture's own, and this is a real check rather than a
 * restatement. If one of these 29 fixtures fails here, the bug is in the WRITE path
 * (this app), not the engine (`packages/contract`) — the engine's own tests already
 * passed before this file runs.
 *
 * SKIPPED ENTIRELY when `DATABASE_URL` is unset — see lease.integration.test.ts's
 * own comment for how to run this for real (inside the `api` Docker container,
 * against the `db-proxy` sidecar).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

interface ConformanceCase {
  name: string;
  fixture: ScheduleFixture;
  today: IsoDate;
}

const gregorianCases: ConformanceCase[] = generationPlanFixtures.map((plan) => ({
  name: plan.name,
  fixture: scheduleFixtures[plan.scheduleFixtureIndex]!,
  today: plan.today,
}));

// `bsYearlyFixture` (BSb3) is exported standalone, not inside `bsScheduleFixtures`
// — see billing.bs.fixtures.ts's own module comment listing BSb3 as the yearly
// case anchored off Baisakh 1. Both are `ScheduleFixture`-shaped, so both belong
// in this suite.
const bsFixtures: readonly ScheduleFixture[] = [...bsScheduleFixtures, bsYearlyFixture];

const bsCases: ConformanceCase[] = bsFixtures.map((fixture) => ({
  name: fixture.name,
  fixture,
  today: addDays(fixture.through, -GENERATION_LOOKAHEAD_DAYS),
}));

const allCases = [...gregorianCases, ...bsCases];

describe.skipIf(!DATABASE_URL)('charge generator conformance — live Postgres, every schedule fixture', () => {
  let db: Database;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
    orgId = `itest_org_conformance_${uuidv7()}`;
    userId = `itest_user_conformance_${uuidv7()}`;
    await db.insert(organization).values({ id: orgId, name: 'Conformance Org', slug: orgId });
    await db.insert(user).values({ id: userId, name: 'Conformance User', email: `${userId}@example.test` });
  });

  afterAll(async () => {
    await db.delete(charge).where(eq(charge.orgId, orgId));
    await db.delete(lease).where(eq(lease.orgId, orgId));
    await db.delete(unit).where(eq(unit.orgId, orgId));
    await db.delete(property).where(eq(property.orgId, orgId));
    await db.delete(organization).where(eq(organization.id, orgId));
    await db.delete(user).where(eq(user.id, userId));
  });

  // docs/TASKS/008-phase3a-backend.md says "all 29 reproduce exactly" — the live
  // fixture set has grown since that count was written (30 in `scheduleFixtures`
  // + 1 in `bsScheduleFixtures` + the standalone `bsYearlyFixture`, BSb3 = 32), so
  // this asserts against the ARRAYS THEMSELVES rather than a hand-copied number —
  // the floor that matters is "every ScheduleFixture-shaped export is covered",
  // not a specific count that drifts every time a fixture is added.
  it(`covers every schedule fixture — scheduleFixtures + bsScheduleFixtures + bsYearlyFixture (${allCases.length} found)`, () => {
    expect(allCases.length).toBe(scheduleFixtures.length + bsFixtures.length);
    expect(allCases.length).toBeGreaterThanOrEqual(29);
  });

  for (const { name, fixture, today } of allCases) {
    it(name, async () => {
      const propertyId = uuidv7();
      await db.insert(property).values({
        id: propertyId,
        orgId,
        name: 'Conformance Property',
        type: 'apartment',
        addressLine1: '1 Test St',
        city: 'Testville',
        region: 'TS',
        postalCode: '00000',
        country: 'US',
        timezone: 'UTC',
        moveOutBillingPolicy: fixture.terms.moveOutBillingPolicy,
        calendar: fixture.terms.calendar,
      });

      const unitId = uuidv7();
      await db.insert(unit).values({
        id: unitId,
        orgId,
        propertyId,
        label: '1A',
        marketRentCents: fixture.terms.rentCents,
        currency: 'USD',
        status: 'occupied',
      });

      const leaseId = uuidv7();
      // Every billing column from `fixture.terms` (PLAN-PHASE3A.md §2.4) — a raw
      // INSERT, not `leaseRepo.createLease`, because this test is about the
      // GENERATOR's write path, not lease-creation business rules (tested
      // elsewhere) — the fixtures are already-pinned-valid terms, and routing them
      // through creation's own validation would only risk rejecting a fixture for
      // a reason that has nothing to do with charge generation.
      await db.insert(lease).values({
        id: leaseId,
        orgId,
        unitId,
        chainId: leaseId,
        startDate: fixture.terms.startDate,
        endDate: fixture.terms.endDate,
        moveOutDate: fixture.terms.moveOutDate,
        rentCents: fixture.terms.rentCents,
        currency: 'USD',
        rentFrequency: fixture.terms.frequency,
        billingDay: fixture.terms.billingDay,
        depositCents: 0,
        openingBalanceCents: 0,
        ledgerStartDate: fixture.terms.ledgerStartDate,
        status: 'active',
        createdByUserId: userId,
      });

      const generatableLease: chargeRepo.GeneratableLease = {
        id: leaseId,
        currency: 'USD',
        rentFrequency: fixture.terms.frequency,
        rentCents: fixture.terms.rentCents,
        billingDay: fixture.terms.billingDay,
        startDate: fixture.terms.startDate,
        endDate: fixture.terms.endDate,
        ledgerStartDate: fixture.terms.ledgerStartDate,
        moveOutDate: fixture.terms.moveOutDate,
        moveOutBillingPolicy: fixture.terms.moveOutBillingPolicy,
        calendar: fixture.terms.calendar,
        depositCents: 0,
        openingBalanceCents: 0,
      };

      await chargeRepo.generateChargesForLease(orgId, db, generatableLease, fixture.terms.rentSteps, today);

      const rows = await db
        .select()
        .from(charge)
        .where(eq(charge.leaseId, leaseId))
        .orderBy(charge.periodStart);

      const rentRows = rows.filter((r) => r.type === 'rent' && r.source === 'generated');
      expect(rentRows).toHaveLength(fixture.expected.length);

      const recovered = rentRows.map((r) =>
        plannedChargeFromCharge({
          id: r.id,
          leaseId: r.leaseId,
          type: r.type,
          generationKey: r.generationKey,
          periodIndex: r.periodIndex,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          occupiedStart: r.occupiedStart,
          occupiedEnd: r.occupiedEnd,
          daysOccupied: r.daysOccupied,
          daysInPeriod: r.daysInPeriod,
          dueDate: r.dueDate,
          amountCents: r.amountCents,
          isProrated: r.isProrated,
          currency: 'USD',
          description: r.description,
          source: r.source,
          supersedesChargeId: r.supersedesChargeId,
          voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
          voidedReason: r.voidedReason,
          createdByUserId: r.createdByUserId,
          createdAt: r.createdAt.toISOString(),
        }),
      );

      expect(recovered).toEqual(fixture.expected);
    });
  }
});
