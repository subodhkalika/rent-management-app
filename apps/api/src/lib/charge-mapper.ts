import { uuidv7, type PlannedCharge } from '@rms/contract';
import type { charge } from '../db/schema.js';

/**
 * The total projection (PLAN-PHASE3A.md §2.3) — the other half of byte-identity.
 *
 * Every one of `PlannedCharge`'s eleven fields lands in its own column and comes
 * back out of it (via the contract's `plannedChargeFromCharge`). Nothing is derived
 * here, and nothing is spread — every field is read by name, which is what makes
 * this the durable defence the contract's own exhaustiveness test checks: adding a
 * twelfth field to `PlannedCharge` does not silently vanish into an `{ ...planned }`
 * spread here, because there is no spread to silently carry it through.
 *
 * Takes a structural `{ id, currency }` rather than any particular lease row type —
 * `repo/charge.ts`'s `GeneratableLease` satisfies it, and so does any other shape
 * carrying the same two fields, without this file needing to import `repo/lease.ts`
 * or `repo/charge.ts` at all.
 */
export interface ChargeLeaseContext {
  id: string;
  currency: string;
}

export function plannedChargeToInsert(
  orgId: string,
  lease: ChargeLeaseContext,
  planned: PlannedCharge,
): typeof charge.$inferInsert {
  return {
    id: uuidv7(),
    orgId,
    leaseId: lease.id,
    type: 'rent',

    generationKey: planned.generationKey,
    periodIndex: planned.periodIndex,
    periodStart: planned.periodStart,
    periodEnd: planned.periodEnd,
    occupiedStart: planned.occupiedStart,
    occupiedEnd: planned.occupiedEnd,
    daysOccupied: planned.daysOccupied,
    daysInPeriod: planned.daysInPeriod,
    dueDate: planned.dueDate,
    amountCents: planned.amountCents,
    isProrated: planned.isProrated,

    currency: lease.currency,
    description: null,
    source: 'generated',
    supersedesChargeId: null,
    createdByUserId: null,
  };
}
