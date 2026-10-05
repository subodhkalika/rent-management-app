import { calendarForSystem, BsDateOutOfRangeError, isoDate, type CalendarSystem, type IsoDate } from '@rms/contract';

/**
 * Renders a CIVIL date — a lease date, a due date, a period boundary — in a
 * property's own calendar.
 *
 * Do NOT call this on an instant (`createdAt`, `updatedAt`, an invite's
 * `expiresAt`, ...). An instant is not a calendar statement (see
 * `docs/DATES.md`) and always stays in the viewer's own locale, regardless of
 * what calendar a property is set to — converting one would be wrong, not just
 * inconsistent, since it is not a date anyone agreed to in that calendar.
 *
 * Gregorian property: the plain local rendering, e.g. "5 Oct 2026".
 *
 * Bikram Sambat property: both calendars, e.g. "19 Ashwin 2083 (5 Oct 2026)". The
 * Gregorian side is kept because a landlord who has switched a property to BS
 * still gets bank statements and council notices dated in Gregorian, and should
 * not lose the ability to cross-reference them.
 *
 * The calendar-specific part is built against `Calendar.decompose` /
 * `Calendar.monthNames`, never against a Bikram-Sambat-specific export — that is
 * what lets this function handle any calendar with no per-calendar switch. The one
 * branch below ("is this the calendar the date is already stored in") is a
 * presentation choice, not calendar-specific logic: it decides whether showing the
 * same date twice would be redundant, which is true for every calendar, not just
 * Gregorian.
 *
 * BS's supported range is roughly AD 1943–2034 (`BS_MIN_YEAR` / `BS_MAX_YEAR` in
 * the contract); a lease end date can genuinely fall outside it. Rather than crash
 * the page, this falls back to the Gregorian rendering on `BsDateOutOfRangeError`.
 */
export function formatCivilDate(date: IsoDate, calendar: CalendarSystem): string {
  // `IsoDate` carries no compile-time brand, so nothing stops a full ISO *instant*
  // (`2026-10-05T08:00:00.000Z`) from type-checking where an `IsoDate` is expected.
  // Catch it here, at runtime, with a message that says why — this is the guard
  // that stops someone "helpfully" running `createdAt` or an invite's `expiresAt`
  // through this function. Reuses the contract's own `isoDate` schema rather than a
  // hand-rolled check, same rule as everywhere else: one definition of "valid".
  if (!isoDate.safeParse(date).success) {
    throw new Error(
      `formatCivilDate expects a civil date (YYYY-MM-DD), got ${JSON.stringify(date)}. ` +
        "An instant (createdAt, expiresAt, ...) is not a calendar statement — render it in " +
        'the viewer\'s own locale instead (e.g. `new Date(value).toLocaleString()`), never ' +
        'through this function.',
    );
  }

  const gregorianRendering = formatGregorian(date);
  if (calendar === 'gregorian') return gregorianRendering;

  try {
    const impl = calendarForSystem(calendar);
    const { year, month, day } = impl.decompose(date);
    const monthName = impl.monthNames[month - 1] ?? String(month);
    return `${day} ${monthName} ${year} (${gregorianRendering})`;
  } catch (error) {
    if (error instanceof BsDateOutOfRangeError) return gregorianRendering;
    throw error;
  }
}

/** The viewer's locale, short month, e.g. "Oct 5, 2026" or "5 Oct 2026" depending
 *  on locale — the same style already used for instants elsewhere in the app. */
function formatGregorian(date: IsoDate): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
