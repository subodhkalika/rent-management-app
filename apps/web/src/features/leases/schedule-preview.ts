import {
  billingTermsFor,
  buildSchedule,
  maxIsoDate,
  type LeaseSummary,
  type PlannedCharge,
  type IsoDate,
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
 * Never compute a date or an amount by hand — `billingTermsFor` is the only
 * sanctioned way to build a `LeaseBillingTerms`, and `buildSchedule` is the only
 * sanctioned way to turn it into charges. `EndLeaseDialog`'s live preview calls
 * this, bounded by the end date the landlord is typing (never an open-ended
 * runway), and reads only its last element — the final charge is the only thing
 * being checked there.
 */
export function previewSchedule(lease: PreviewLeaseInput, through: IsoDate): PlannedCharge[] {
  return buildSchedule(billingTermsFor(lease), through);
}

/**
 * THE call the create wizard's review step makes. A five-year monthly lease has
 * no business constructing sixty `PlannedCharge` objects on every keystroke in
 * the terms step just to show the first one. `through` is pinned to the window's
 * own start — `max(startDate, ledgerStartDate)` — so `buildSchedule` returns
 * exactly the single period that contains it, never the rest of the term.
 *
 * `undefined` only when the lease has no occupied window at all (`endDate`
 * before `startDate`, which form validation rejects before this ever runs) —
 * never a stand-in for "still loading".
 */
export function previewFirstPeriod(lease: PreviewLeaseInput): PlannedCharge | undefined {
  const windowStart = maxIsoDate(lease.startDate, lease.ledgerStartDate);
  return buildSchedule(billingTermsFor(lease), windowStart)[0];
}
