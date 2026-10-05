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
}

function supportedTimezones(): string[] {
  // `Intl.supportedValuesOf` is in every evergreen browser; fall back to just the
  // browser's own zone on the rare runtime that lacks it, so the form still works.
  if (typeof Intl.supportedValuesOf === 'function') {
    return Intl.supportedValuesOf('timeZone').map(tz => tz === 'Asia/Katmandu' ? 'Asia/Kathmandu' : tz);
  }
  return [browserTimezone()];
}

export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export const timezoneOptions: TimezoneOption[] = supportedTimezones()
  .map((name) => ({ value: name, label: name.replace(/_/g, ' ') }))
  .sort((a, b) => a.label.localeCompare(b.label));
