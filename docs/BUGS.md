# Open issues

Found by hand while using the app. **Not fixed** — these are recorded here so the
fix is quick when it is wanted, with the cause already traced.

Last updated: 2026-10-11.

---

## 1. The country field only accepts two characters

**Reported:** "add property form, country only allows two characters, I cannot type nepal"

`packages/contract/src/property.ts:38` — `country` is
`z.string().trim().length(2).toUpperCase()`. It is an ISO 3166 alpha-2 code by
design, so the field is behaving as specified. The specification is the problem: it
asks a person to know that Nepal is `NP`.

**Fix shape:** keep storing the two-letter code, stop asking for it. A searchable
country select showing names and submitting codes. The same shape as the timezone
picker, which already solved this.

**Touches the contract**, so both apps and a frozen schema.

---

## 2. Add-property defaults are wrong for this user

**Reported:** "the add property modal should by default select Bikram Sambat calendar
and on the move out billing, it should by default select the stop billing on the move
out date option"

Not a defect — the form defaults to Gregorian and `bill_full_term`.

**Worth deciding rather than just changing.** Hardcoding Bikram Sambat is right for a
Nepali landlord and wrong for everyone else. Two better options:

- Default the calendar from the browser's locale or the chosen country, the way the
  timezone picker already defaults from the browser's zone.
- Remember the last value used in this organization — most landlords' properties are
  in one place.

`stop_at_move_out` as the move-out default is a straightforward change and probably
the better default generally: billing past the day someone left needs a reason.

---

## 3. NPR is missing from the currency list

**Reported:** "The Add unit form does not have NPR as currency in the options"

`packages/contract/src/common.ts:67` — `currency` is
`z.enum(['USD','EUR','GBP','INR','AUD','CAD'])`. NPR was never included, so a Nepali
property cannot record rent in its own currency.

**Fix shape:** add `NPR`. Check `formatMoney` renders it as expected, and confirm
nothing assumes a two-decimal minor unit that NPR does not share (it does — paisa,
100 to the rupee — so this should be a one-line change plus a test).

**Touches the contract.** Adding an enum value is additive and safe; no stored data
changes.

---

## 4. An optional email is rejected when left empty

**Reported:** "The add tenant modal says Enter a valid email address for optional
field. same with edit when empty on optional field."

`packages/contract/src/tenant.ts:39` — `email` is `.email().optional()`. `optional()`
accepts `undefined`, not `''`. A text input that has been focused and left blank
submits `''`, which is not undefined, so `.email()` runs on it and fails.

The same class of bug the frontend already fixed once for `notes` and
`address.line2` via `blankToUndefined` — this field was missed, and so were the other
optional text fields on the tenant form.

**Fix shape:** two layers, because either alone leaves the trap.

- Contract: accept an empty string as absent, so the API cannot be broken by a
  client that sends `''`.
- Web: route every optional text field through `blankToUndefined`, and check the
  other forms for the same omission rather than fixing only the two that were
  reported.

---

## Notes

Every one of these was found by using the app, not by a test. Three of the four are
about a non-US, non-Latin landlord — a country that is not two letters anyone
remembers, a calendar that is not Gregorian, a currency that was never listed. Worth
assuming there are more of that shape.
