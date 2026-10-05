import { billingTermsFor, buildSchedule, addDays, type LeaseSummary, type PlannedCharge, type IsoDate } from '@rms/contract';

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
 * How far forward to preview when there's no `endDate` to bound it. A rolling
 * lease could otherwise want an unbounded schedule — this just decides how much of
 * it a screen renders, a display concern, not a billing one. `addDays` is the
 * contract's own pure day-number helper (not a second date-maths implementation),
 * used here only to pick a window, never to decide a period, a due date, or an
 * amount — all of those still come from `buildSchedule` alone.
 */
export function defaultPreviewThrough(startDate: IsoDate, endDate: IsoDate | null): IsoDate {
  if (endDate) return endDate;
  return addDays(startDate, 366 * 3);
}
