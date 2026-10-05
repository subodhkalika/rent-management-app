# Task 007 — A Bikram Sambat date input

**Status:** queued. Not urgent, but it is a real hole for the users BS was built for.

## The gap

Lease dates are *entered* with a native `<input type="date">`, which is a Gregorian
picker in every browser. So on a Bikram Sambat property a landlord **reads** dates as
`19 Ashwin 2083` (via `formatCivilDate`) but must **type** them as `2026-10-05`.

Nothing is stored wrong — the value round-trips correctly and every calculation is
right. It is purely an input-side asymmetry, and it falls on exactly the people the
calendar work was for: a Nepali landlord thinks in BS and has to convert in their head
to use the form.

## What to build

A date input that accepts and displays the property's own calendar, used wherever a
**civil** date is entered: lease start, end, move-out, ledger start.

- Gregorian properties keep the native picker. It is good, accessible, and localised
  for free — do not replace what works.
- Bikram Sambat gets year / month / day selects driven by
  `calendarForSystem('bikram_sambat')`: `monthNames` for the month list and
  `daysInMonth(year, month)` for the day list, which varies 29–32 and must come from
  the calendar rather than a constant.
- Convert to the stored Gregorian `IsoDate` with the contract's `isoFromBs`. Never
  write BS to the wire — storage stays Gregorian ISO under every calendar.
- Show the Gregorian equivalent beneath the input as the user types, the same
  cross-reference `formatCivilDate` already gives on the read side.
- BS covers roughly AD 1943–2034. Outside that, `isoFromBs` throws — the input must
  say so plainly rather than silently producing nothing. A lease ending in 2040 is
  not far-fetched.

**Do not write a conversion.** `isoFromBs` and `decompose` exist and their table is
cross-verified. A second implementation is the bug `docs/DATES.md` exists to prevent.

## Tests

- A BS property's input writes the correct Gregorian `IsoDate`.
- The day list changes length between a 31-day and a 32-day BS month.
- Out-of-range shows an error rather than failing silently.
- A Gregorian property still uses the native input.
