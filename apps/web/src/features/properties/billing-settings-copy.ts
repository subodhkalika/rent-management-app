import type { CalendarSystem, MoveOutBillingPolicy } from '@rms/contract';

/**
 * Plain-language copy for the two property-level billing settings, shared between
 * the property form and the property detail page so the wording never drifts
 * between "what we asked for" and "what we're showing back".
 */

/** Short label, not the enum value — used anywhere the setting needs a name. */
export const moveOutBillingPolicyTitle: Record<MoveOutBillingPolicy, string> = {
  bill_full_term: 'Bill the full term even if they leave early',
  stop_at_move_out: 'Stop billing on the move-out date',
};

/** One-line consequence for a departing tenant — this setting decides whether they
 *  owe the remainder of the term. */
export const moveOutBillingPolicyHelp: Record<MoveOutBillingPolicy, string> = {
  bill_full_term: 'A tenant who leaves early still owes rent through the end of the lease term.',
  stop_at_move_out: 'Rent stops on the move-out date. The final charge is prorated to that date.',
};

/** What each calendar means for billing periods, not just how dates are displayed. */
export const calendarSystemHelp: Record<CalendarSystem, string> = {
  gregorian:
    'Billing periods follow the Gregorian calendar — a monthly lease runs January to February, and so on.',
  bikram_sambat:
    'Billing periods follow the Bikram Sambat calendar — a monthly lease runs Baisakh to Jestha, not January to February.',
};
