import { describe, it, expect } from 'vitest';
import {
  scheduleFixtures,
  bsScheduleFixtures,
  bsYearlyFixture,
  PLANNED_CHARGE_KEYS,
  plannedChargeFromCharge,
  type Charge,
  type PlannedCharge,
} from '@rms/contract';
import { plannedChargeToInsert, type ChargeLeaseContext } from './charge-mapper.js';

/**
 * Pure (no DB) proof of PLAN-PHASE3A.md §2.3's two tests:
 *
 * 1. Round-trip: for every fixture's `expected` element, `plannedChargeFromCharge`
 *    recovers EXACTLY what `plannedChargeToInsert` was given.
 * 2. Exhaustiveness: every one of `PLANNED_CHARGE_KEYS` is both present on a
 *    fully-distinct `PlannedCharge` and correctly reflected in the insert row —
 *    the durable defence against a twelfth field silently vanishing on the way
 *    into the database, since `plannedChargeToInsert` reads each field BY NAME,
 *    never via a spread.
 */

const lease: ChargeLeaseContext = { id: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f', currency: 'USD' };

/** The DB-insert shape, reconstituted as a `Charge` — exactly what a real SELECT
 *  would hand back (the conformance test is the one that proves THAT part against
 *  real Postgres; this file only proves the mapping is lossless in memory). */
function asCharge(insert: ReturnType<typeof plannedChargeToInsert>): Charge {
  return {
    id: insert.id as string,
    leaseId: insert.leaseId as string,
    type: insert.type as Charge['type'],
    generationKey: insert.generationKey ?? null,
    periodIndex: insert.periodIndex ?? null,
    periodStart: insert.periodStart ?? null,
    periodEnd: insert.periodEnd ?? null,
    occupiedStart: insert.occupiedStart ?? null,
    occupiedEnd: insert.occupiedEnd ?? null,
    daysOccupied: insert.daysOccupied ?? null,
    daysInPeriod: insert.daysInPeriod ?? null,
    dueDate: insert.dueDate as string,
    amountCents: insert.amountCents as number,
    isProrated: insert.isProrated as boolean,
    currency: insert.currency as Charge['currency'],
    description: insert.description ?? null,
    source: insert.source as Charge['source'],
    supersedesChargeId: insert.supersedesChargeId ?? null,
    voidedAt: null,
    voidedReason: null,
    createdByUserId: insert.createdByUserId ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

// `bsYearlyFixture` (BSb3) is exported standalone, not inside `bsScheduleFixtures`
// — see the conformance integration test's own comment on why both are needed.
const allFixtures = [...scheduleFixtures, ...bsScheduleFixtures, bsYearlyFixture];

describe('plannedChargeToInsert — the total projection (PLAN-PHASE3A.md §2.3)', () => {
  describe('round-trip: plannedChargeFromCharge(asCharge(plannedChargeToInsert(...))) === the original PlannedCharge', () => {
    for (const fixture of allFixtures) {
      it(fixture.name, () => {
        for (const expected of fixture.expected) {
          const insert = plannedChargeToInsert('org_1', lease, expected);
          const recovered = plannedChargeFromCharge(asCharge(insert));
          expect(recovered).toEqual(expected);
        }
      });
    }
  });

  it('exhaustiveness: PLANNED_CHARGE_KEYS matches a fully-distinct PlannedCharge\'s own keys, and every one round-trips', () => {
    const planned: PlannedCharge = {
      generationKey: '2026-04-01',
      periodIndex: 7,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      occupiedStart: '2026-04-05',
      occupiedEnd: '2026-04-30',
      daysOccupied: 26,
      daysInPeriod: 30,
      dueDate: '2026-04-05',
      amountCents: 86667,
      isProrated: true,
    };
    // Adding a 12th field to PlannedCharge without a matching column fails THIS
    // assertion first — Object.keys(planned) would grow, PLANNED_CHARGE_KEYS
    // would not, until the contract's own list is updated too.
    expect(Object.keys(planned).sort()).toEqual([...PLANNED_CHARGE_KEYS].sort());

    const insert = plannedChargeToInsert('org_1', lease, planned);
    for (const key of PLANNED_CHARGE_KEYS) {
      expect(insert[key as keyof typeof insert], `plannedChargeToInsert dropped or mismapped "${key}"`).toEqual(
        planned[key],
      );
    }
  });

  it('always writes type: rent, source: generated, generationKey from the planned charge, and no manual-only fields', () => {
    const planned: PlannedCharge = {
      generationKey: '2026-04-01',
      periodIndex: 0,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
      occupiedStart: '2026-04-01',
      occupiedEnd: '2026-04-30',
      daysOccupied: 30,
      daysInPeriod: 30,
      dueDate: '2026-04-01',
      amountCents: 100000,
      isProrated: false,
    };
    const insert = plannedChargeToInsert('org_1', lease, planned);
    expect(insert.type).toBe('rent');
    expect(insert.source).toBe('generated');
    expect(insert.generationKey).toBe('2026-04-01');
    expect(insert.supersedesChargeId).toBeNull();
    // NULL means the generator wrote it — the audit signal, not a separate column.
    expect(insert.createdByUserId).toBeNull();
    expect(insert.description).toBeNull();
    expect(insert.orgId).toBe('org_1');
    expect(insert.leaseId).toBe(lease.id);
    expect(insert.currency).toBe(lease.currency);
  });
});
