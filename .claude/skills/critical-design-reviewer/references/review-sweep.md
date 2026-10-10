# Review sweep: where everything is

A map so you spend your effort judging rather than hunting. **Everything here is a
starting point to verify, not a finding.** Open the file before you cite it; line
numbers and behaviour drift.

---

## 1. Surfaces

All signed-in routes mount inside `apps/web/src/components/layout/AppShell.tsx` —
one shared header, no sidebar. Routes are declared in `apps/web/src/App.tsx`.

**Landlord** (guarded by `RequireLandlord`; nav shows 5 items):

| Route | Component | What it is |
|---|---|---|
| `/` | → `/properties` | there is no dashboard or home surface |
| `/properties` | `properties/PropertiesListPage` | table: name, address, type, occupancy |
| `/properties/:id` | `properties/PropertyDetailPage` | + `units/UnitsSection` |
| `/tenants` | `tenants/TenantsListPage` | table: name, email, phone, status, portal |
| `/tenants/:id` | `tenants/TenantDetailPage` | + `PortalAccessPanel`, `TenantLeasesCard` |
| `/leases` | `leases/LeasesListPage` | table: unit, tenant, term, rent, status |
| `/leases/new` | `leases/wizard/CreateLeasePage` | 4-step wizard — the only full-page flow |
| `/leases/:id` | `leases/LeaseDetailPage` | tabs; `LedgerPanel`, `LeaseRosterPanel`, `LeaseChainTimeline`, `DriftBanner` |
| `/charges` | `charges/ChargesListPage` | filtered list of every charge |
| `/arrears` | `payments/ArrearsPage` | who is behind, grouped by currency |

**Tenant portal** (`RequireTenant`; nav shows 2 items):
`/portal/leases`, `/portal/leases/:id`, `/portal/profile`, plus the unguarded
`/portal/accept` invite page. Panels: `PortalChargesPanel`, `PortalPaymentsPanel`,
`PortalBalanceHeadline`.

**Auth**: `/signin` `/signup` `/forgot-password` `/reset-password` `/onboarding`.

`*` renders an inline `Placeholder` in `App.tsx` — "Page not found. Not built yet."

---

## 2. Mutations

Every mutation is a dialog (20 of them). Worth checking each for: stated
consequence, preview before an irreversible action, focus return, and whether a
dialog is the right container at all.

- **Money**: `RecordPaymentDialog` `CorrectPaymentDialog` `VoidPaymentDialog`
  `ReturnDepositDialog` · `CreateChargeDialog` `CorrectChargeDialog`
  `VoidChargeDialog` · `GenerateNextPeriodAction`
- **Lease lifecycle**: `ActivateLeaseDialog` `CancelLeaseDialog` `EndLeaseDialog`
  `RenewLeaseDialog` `DeleteLeaseDialog` `AddLeaseTenantDialog` `CascadeDiffDialog`
- **CRUD**: `PropertyFormDialog` `DeletePropertyDialog` `UnitFormDialog`
  `DeleteUnitDialog` `TenantFormDialog` `DeleteTenantDialog`

Preview helpers worth judging for clarity, since they are what stands between a
landlord and a surprise: `payments/allocation-preview.ts`,
`charges/generation-preview.ts`, `charges/next-period-preview.ts`,
`leases/schedule-preview.ts`, `leases/rent-ladder.ts`.

---

## 3. Starting observations

Verified by reading the source on 2026-10-11. **Re-check before citing** — and note
that several are defensible choices, not automatic defects. Your job is to decide
which, and to say why.

- **No landing surface.** `/` redirects to `/properties`, a static inventory list.
  Nothing answers "what needs me today" on arrival. Judge against the landlord's
  actual daily loop.
- **Money is spread across three places** — `/charges`, `/arrears`, and each lease's
  `LedgerPanel`. Work out whether a landlord can answer "who owes me, and what do I
  do" without navigating between them.
- **No column sorting anywhere.** No table has sortable headers. Lists paginate with
  a `Load more` cursor button, so a user cannot jump, and sorting cannot be faked by
  scrolling.
- **Filtering is uneven.** `/charges`, `/leases` and `/arrears` have filter bars;
  `/tenants` and `/properties` have neither filter nor search. Decide whether that
  asymmetry is scale-appropriate or a gap.
- **No bulk actions and no global search** anywhere in the product.
- **Responsiveness is thin.** Only `sm:` breakpoints appear, and not on a single
  list page — every table overflows on a narrow viewport. Weigh this differently for
  landlord screens (laptop-first, defensible) and the **tenant portal**, where
  phones are the expected device.
- **Dark mode is defined but unreachable.** Full `.dark` token set in `index.css`;
  nothing toggles the class, `next-themes` is imported only by `ui/sonner.tsx`.
- **The lease detail header** renders a status-conditional cluster of up to several
  buttons. Check whether exactly one primary action is distinguished.
- **Delete vs cancel vs end** are three adjacent lease verbs. Check that a landlord
  can tell which one they want before clicking.
- Things that look right on reading and are worth protecting: the four-state pattern
  on every list page, `ArrearsPage`'s two distinct empty states, the activation
  preview showing count and total, `DriftBanner`, centralised enum labels in the
  contract, and `civil-date-input`'s calendar awareness.

---

## 4. Conventions a finding can be measured against

Not your opinions — the project's own, so a violation is objective.

- `docs/ARCHITECTURE.md` §8: loading, empty and error states required on every
  screen; typecheck, lint and tests must pass.
- `.claude/agents/frontend-dev.md`: four states; labels tied to inputs; keyboard
  reachable; focus visible; errors via `aria-live`; dialogs trap focus and close on
  Escape; shadcn over hand-rolled; Tailwind only; no bare `fetch` in a component.
- `docs/BEHAVIOUR.md`: the domain rules. Immutable charges and payments; void ≠
  correct ≠ refund; charges only once their period has started; oldest-debt-first
  allocation across the whole tenancy; deposits separate from rent; balances phrased
  not signed; overdue in the property's timezone; money in whole cents.
- `docs/DATES.md`: no date arithmetic in `apps/web` — enforced by
  `src/no-date-arithmetic.guard.test.ts`.
- Design system: semantic tokens only (no raw colours); badge variants go through
  each feature's `*-ui.ts` map; enum labels imported from `@rms/contract`, never
  retyped.

---

## 5. Running it, if you need to

```bash
docker compose up                      # web :5173, api :8787, db :5433
pnpm --filter web test                 # component tests
pnpm --filter web typecheck && pnpm --filter web lint
```

There is no seed data — sign up, create an organization, and you land on an empty
properties list. That first-run path is itself worth reviewing.

If you do not run any of this, say so in the verification block and mark
appearance-dependent findings as hypotheses.
