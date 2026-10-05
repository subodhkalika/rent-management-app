import type { RentFrequency, MoveOutBillingPolicy, IsoDate } from '@rms/contract';
import { formatCivilDate } from '@/lib/format-civil-date';
import type { CalendarSystem } from '@rms/contract';

/**
 * Plain-language copy for the rent-frequency toggle on the lease terms step
 * (docs/PLAN-PHASE2.md §8.2 item 4). `billingDay` means something different —
 * and is meaningless at all — for each cadence, so the help text and whether the
 * field even shows must come from one place, not be re-derived next to each field.
 */
export const frequencyBillingDayHelp: Record<RentFrequency, string> = {
  monthly: 'We bill the last day of shorter months — 31 becomes 28 in February.',
  yearly: 'A yearly lease is due on the first day of each lease year.',
};

/** Whether the billing-day field makes sense for this cadence at all. */
export function showsBillingDay(frequency: RentFrequency): boolean {
  return frequency === 'monthly';
}

/**
 * Move-out billing copy for the lease form and the End-lease dialog, driven by the
 * LEASE's own `moveOutBillingPolicy` (read live from its property — Amendment A),
 * never hardcoded. `endDate` is formatted through `formatCivilDate` because it's a
 * civil date, not an instant (docs/DATES.md) — a Bikram Sambat property must see
 * its own calendar here too.
 */
export function moveOutBillingCopy(
  policy: MoveOutBillingPolicy,
  endDate: IsoDate | null,
  calendar: CalendarSystem,
): string {
  if (policy === 'bill_full_term') {
    return endDate
      ? `Rent is billed to the end of the term (${formatCivilDate(endDate, calendar)}) whatever date they move out. Change this on the property if your policy differs.`
      : 'Rent is billed to the end of the term whatever date they move out. Change this on the property if your policy differs.';
  }
  return 'Rent stops on the move-out date. The final charge will be prorated.';
}
