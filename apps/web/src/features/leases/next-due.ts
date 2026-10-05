import { compareIsoDate, localToday, type PlannedCharge, type Timezone } from '@rms/contract';

/**
 * Index of the first period not yet due, evaluated in the PROPERTY's own timezone
 * — never the browser's. "What is today" is the one timezone-sensitive question in
 * this system (docs/DATES.md, PLAN-PHASE2.md §1.8); a lease form or schedule table
 * that used the viewer's local clock instead would mark a Perth property's rent
 * overdue up to a day early or late for a landlord sitting somewhere else.
 *
 * Returns -1 when every period is already due (or there are none).
 */
export function nextDuePeriodIndex(
  periods: readonly PlannedCharge[],
  propertyTimezone: Timezone,
  now: Date = new Date(),
): number {
  const today = localToday(propertyTimezone, now);
  return periods.findIndex((p) => compareIsoDate(p.dueDate, today) >= 0);
}
