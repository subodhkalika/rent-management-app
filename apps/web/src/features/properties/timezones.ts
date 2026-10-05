/**
 * IANA timezone names for the property form's combobox, plus the browser's own
 * zone as the sensible default — see `PropertyFormDialog`.
 *
 * `property.timezone` is the only timezone-sensitive value in the system (see
 * `packages/contract/src/property.ts`), so defaulting to UTC here would be wrong
 * for most landlords. The browser's zone is right far more often than not.
 */

export interface TimezoneOption {
  value: string;
  label: string;
  /**
   * Extra search terms for this zone — a more common modern city name, when ICU's
   * canonical identifier is an older one. See `LEGACY_ZONE_SEARCH_TERMS` below.
   */
  keywords?: string[];
}

/**
 * `Intl.supportedValuesOf('timeZone')` canonicalizes a handful of zones to a
 * pre-1995-ish IANA name (`Asia/Calcutta`, not `Asia/Kolkata`) even though
 * everyone, including Indian landlords, types the modern one. There is no
 * platform call that goes the other way: passing the modern name to
 * `Intl.DateTimeFormat` is accepted, but it just normalizes straight back to the
 * legacy one ICU already gave us — so it cannot tell us a mapping we don't
 * already have. That makes this a short, deliberate, hand-kept list of search
 * terms, not a stored-value override: the combobox `value` for each of these
 * stays exactly what ICU returned, so it matches what the server and the
 * contract validate. Only the search term is extra.
 */
const LEGACY_ZONE_SEARCH_TERMS: Record<string, string[]> = {
  'Asia/Calcutta': ['Kolkata'],
  'Asia/Katmandu': ['Kathmandu'],
  'Asia/Saigon': ['Ho Chi Minh', 'Ho Chi Minh City'],
  'Europe/Kiev': ['Kyiv'],
};

function supportedTimezones(): string[] {
  // `Intl.supportedValuesOf` is in every evergreen browser; fall back to just the
  // browser's own zone on the rare runtime that lacks it, so the form still works.
  if (typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone');
  }
  return [browserTimezone()];
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// `Intl.supportedValuesOf('timeZone')` never includes 'UTC' (confirmed on Node
// 22 and every evergreen browser engine) even though it is a perfectly valid
// IANA zone the contract accepts — and the current stored value of every
// property in the system, since that was the only previous default. Add it
// back explicitly rather than letting it silently fail to appear as an option.
const UTC_OPTION: TimezoneOption = { value: 'UTC', label: 'UTC' };

const otherZoneOptions: TimezoneOption[] = supportedTimezones()
  .filter((name) => name !== 'UTC')
  .map((name) => ({
    value: name,
    label: name.replace(/_/g, ' '),
    keywords: LEGACY_ZONE_SEARCH_TERMS[name],
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

// UTC pinned first: it's the one every existing property already has, so it
// should be the easiest option to find, not buried alphabetically under "U".
export const timezoneOptions: TimezoneOption[] = [UTC_OPTION, ...otherZoneOptions];
