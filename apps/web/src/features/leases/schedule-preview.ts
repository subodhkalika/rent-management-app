import {
  billingTermsFor,
  buildSchedule,
  addDays,
  maxIsoDate,
  minIsoDate,
  localToday,
  type LeaseSummary,
  type PlannedCharge,
  type IsoDate,
  type Timezone,
} from '@rms/contract';

/**
 * Everything `billingTermsFor` needs, in `LeaseSummary`'s own field names
 * (`rentFrequency`, not `frequency`) — the create wizard builds this straight from
 * form state plus the selected unit's property, never from a saved lease.
 */
export type PreviewLeaseInput = Pick<
  LeaseSummary,
  | 'rentFrequency'
  | 'rentCents'
  | 'billingDay'
  | 'startDate'
  | 'endDate'
  | 'ledgerStartDate'
  | 'moveOutDate'
  | 'moveOutBillingPolicy'
  | 'calendar'
>;

/**
 * THE call this whole phase exists for. Never compute a date or an amount by hand —
 * `billingTermsFor` is the only sanctioned way to build a `LeaseBillingTerms`, and
 * `buildSchedule` is the only sanctioned way to turn it into charges. This is the
 * exact function the create wizard's review step, the end-lease dialog's live
 * preview, and (via the API) the backend's `/schedule` routes all call — so the
 * number a landlord previews here is the number they would be billed.
 */
export function previewSchedule(lease: PreviewLeaseInput, through: IsoDate): PlannedCharge[] {
  return buildSchedule(billingTermsFor(lease), through);
}

/**
 * Mirrors `apps/api/src/lib/schedule.ts`'s `TEN_YEARS_IN_DAYS` exactly — the
 * backend's own INPUT SANITY ceiling ("through must be within 10 years of
 * startDate"), not a billing computation. Pure day-count arithmetic, never
 * calendar-dependent, so it can never throw for a Bikram Sambat property. Not
 * imported (the backend's constant lives in an apps/api-only file) but pinned to
 * the identical value so the preview can never ask the route for a window it would
 * 422 on — a lease running longer than this clamps, it does not error.
 */
const SCHEDULE_SANITY_DAYS = 3653;

/** How far forward the create wizard's and lease-detail's preview windows run,
 *  from whichever is later: the lease's start, or today. Three years is enough
 *  runway to be useful without the table growing unbounded. */
const PREVIEW_RUNWAY_DAYS = 366 * 3;

/**
 * How far forward to preview. A display choice, not a billing one — it only picks
 * the `through` argument handed to `buildSchedule`, never a period, a due date or
 * an amount — so computing it here, outside `billing.ts`, is legitimate.
 *
 * MUST anchor on TODAY (in the property's own timezone — §1.8, never the
 * browser's), not on `startDate` alone. A rolling lease that started years ago is
 * the NORMAL case for a long-running tenancy: anchoring purely on `startDate`
 * walked the window into the past the moment a lease was more than
 * `PREVIEW_RUNWAY_DAYS` old, showing a schedule with no current period and no
 * "next due" row for every single one of them. Clamped to `endDate` when present,
 * and to the backend's own 10-year-from-`startDate` sanity bound either way, so
 * this can never ask `GET .../schedule` for a `through` it will 422 on.
 */
export function defaultPreviewThrough(
  startDate: IsoDate,
  endDate: IsoDate | null,
  propertyTimezone: Timezone,
  now?: Date,
): IsoDate {
  const today = localToday(propertyTimezone, now);
  const windowStart = maxIsoDate(startDate, today);
  const forward = addDays(windowStart, PREVIEW_RUNWAY_DAYS);
  const sanityCap = addDays(startDate, SCHEDULE_SANITY_DAYS);
  const upperBound = endDate ? minIsoDate(endDate, sanityCap) : sanityCap;
  return minIsoDate(forward, upperBound);
}
