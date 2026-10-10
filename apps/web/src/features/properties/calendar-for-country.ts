import type { CalendarSystem } from '@rms/contract';

/**
 * The one country/calendar pairing a landlord shouldn't have to spell out by
 * hand. Bikram Sambat is Nepal's civil calendar — everywhere else defaults to
 * Gregorian. Deliberately not a bigger table: BS is the only non-Gregorian
 * calendar the contract's `calendarSystem` enum supports today, so this is
 * exhaustive, not a shortcut that happens to cover the common cases.
 */
export function calendarSystemForCountry(country: string): CalendarSystem {
  return country === 'NP' ? 'bikram_sambat' : 'gregorian';
}
