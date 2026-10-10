# Issues found by hand

Found by using the app, not by a test. **All six below are fixed** (2026-10-11) —
kept as a record of what the causes turned out to be, because two of them were the
same mistake twice and the other four were the same assumption four times.

Add new findings above this line as they come up.

---

## ✅ 1. The country field only accepts two characters

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

## ✅ 2. Add-property defaults are wrong for this user

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

## ✅ 3. NPR is missing from the currency list

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

## ✅ 4. An optional email is rejected when left empty

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

## ✅ 5. The lease page white-screens right after creating a lease — CRASH

**Reported:** "got Something went wrong … when creating a lease.
`TypeError: Cannot read properties of undefined (reading 'map')` at
`LeaseRosterPanel.tsx:41`"

The only crash on this list, and a blocker: the lease you just made is unreachable
until you reload.

**Cause, traced.** `packages/contract/src/lease.ts` has two shapes —
`lease = leaseSummary` (line 420) and `leaseDetail = leaseSummary.extend({ tenants, … })`
(line 432). Only the detail shape carries `tenants`.

`apps/web/src/features/leases/api.ts:86-89` parses the create response with the
**summary** schema and then seeds it into the **detail** cache key:

```ts
mutationFn: ... { schema: lease }                                  // summary — no tenants
onSuccess: (created) =>
  queryClient.setQueryData(leasesKeys.detail(created.id), created) // stored as detail
```

The page then reads that cached object, `lease.tenants` is `undefined`, and
`.map()` throws. Reloading works because the real `GET` replaces the cache with a
genuine detail response — the same tell as the onboarding bug.

TypeScript did not catch it because `leasesKeys.detail()` returns a plain tuple
(`api.ts:26`), so `setQueryData` has no type to compare the summary against.

**Fix shape:** do not seed a detail cache from a summary response. Either invalidate
the detail key and let it fetch, or have `POST /v1/leases` return the detail shape.
Invalidating is the smaller change and removes the class of bug; returning detail is
the one that makes the crash unrepresentable.

Then look for the same pattern elsewhere — any `setQueryData` on a detail key fed by
a mutation response is the same trap. Typing the key factory so a summary cannot be
written to a detail key would close it permanently.

---

## ✅ 6. Unit fields assume a residential flat

**Reported:** "on add unit, bathroom info not required. keep bedrooms as rooms label.
better to add it like unit type: shutter, room, flat etc. For a person who rents a
shutter the verbiage of room or bedroom doesn't suit."

`createUnitBody` requires `bedrooms` and `bathrooms`. For a shop shutter, a single
room, or a garage, both are meaningless and one is mandatory.

**Fix shape:** a `unitType` — shutter, room, flat, house, garage, other — and let it
decide which fields appear. A flat asks for bedrooms and bathrooms; a shutter asks
for neither and perhaps asks for floor area instead. `bedrooms` and `bathrooms`
become optional in the contract.

This is the same shape as issues 1, 2 and 3: the model assumes a residential
Western let. It is the largest of them, because it changes the unit schema rather
than a field's rules.

---

## Notes

Two patterns ran through these, and both are worth remembering.

**Four of the six assumed a US-or-European residential landlord**: a country code you
are expected to know, a Gregorian calendar, a currency that was never listed, and a
bedroom count demanded of a shop shutter. None of them were visible from inside the
code — they needed somebody in Nepal renting a shutter to find them.

**Two were the same mistake**: trusting a client cache the server had already moved
past. Onboarding navigated on a stale actor context; creating a lease seeded a detail
cache from a summary response. Both had the identical tell — a reload fixed it. The
second is now a compile error rather than a correction, because a mistake made twice
will be made a third time.

Every one of these was found by clicking, and not one of them would have been caught
by a test. That is not an argument for fewer tests; it is an argument for using the
thing you are building.
