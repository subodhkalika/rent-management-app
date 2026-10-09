import {
  billingTermsFor,
  chargesDueForGeneration,
  chargesThroughNextPeriod,
  localToday,
  type Charge,
  type IsoDate,
  type LeaseDetail,
} from '@rms/contract';

export interface NextPeriodPreview {
  generationKey: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  dueDate: IsoDate;
  amountCents: number;
  /**
   * A charge — voided or not — already occupies this period's generation key, so
   * the action would write nothing. `charge_generation_uq` has no predicate on
   * `voided_at`, so a voided row still blocks the key forever; the caller must pass
   * voided rows in `rentCharges` or this under-reports.
   */
  alreadyGenerated: boolean;
}

/**
 * What `POST /leases/:id/charges/generate-next-period` will write, computed the
 * same way the engine computes it (`chargesThroughNextPeriod`) — the landlord
 * billing one period early on purpose: a tenant turns up wanting to pay the next
 * period's rent before the scheduled run would create it.
 *
 * Exactly one period ahead of whatever `chargesDueForGeneration` already covers.
 * Returns `null` when there is no such period to reach into yet — e.g. the
 * schedule has nothing beyond what's already due (the lease is ending, or hasn't
 * reached its own ledger start).
 *
 * `rentCharges` must be every generated rent charge for the lease, VOIDED
 * INCLUDED — the same requirement `diffChargesAgainstSchedule` has, and for the
 * same reason.
 */
export function previewNextPeriodCharge(
  lease: LeaseDetail,
  rentCharges: readonly Charge[],
): NextPeriodPreview | null {
  const today = localToday(lease.propertyTimezone);
  const terms = billingTermsFor(lease);

  const due = chargesDueForGeneration(terms, today);
  const dueKeys = new Set(due.map((p) => p.generationKey));

  const throughNext = chargesThroughNextPeriod(terms, today);
  const next = throughNext.find((p) => !dueKeys.has(p.generationKey));
  if (!next) return null;

  const alreadyGenerated = rentCharges.some((c) => c.generationKey === next.generationKey);

  return {
    generationKey: next.generationKey,
    periodStart: next.periodStart,
    periodEnd: next.periodEnd,
    dueDate: next.dueDate,
    amountCents: next.amountCents,
    alreadyGenerated,
  };
}
