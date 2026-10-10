# What you build with

The materials available in `apps/web`. Read before specifying or implementing
anything. Verify against the files — this is a map, not a substitute for the code.

---

## 1. Tokens

Defined once in `apps/web/src/index.css` as OKLCH custom properties, exposed to
Tailwind 4 via `@theme inline`. shadcn "new-york" style, slate base,
`--radius: 0.625rem`.

Semantic colours only. **Never write a raw colour** (`text-blue-600`, `#1a1a1a`,
`bg-[...]`). Use:

| Role | Classes |
|---|---|
| Surface | `bg-background` `bg-card` `bg-popover` `bg-muted` |
| Text | `text-foreground` `text-muted-foreground` `text-card-foreground` |
| Emphasis | `bg-primary text-primary-foreground` `bg-secondary` `bg-accent` |
| Danger | `bg-destructive text-destructive-foreground` / `variant="destructive"` |
| Lines | `border-border` `border-input` `ring-ring` |

A dark palette exists under `.dark` but **nothing toggles the class today** —
`next-themes` is imported only by `components/ui/sonner.tsx`. So: keep every new
surface token-based so dark mode works the day it is switched on, but do not claim
the app supports dark mode, and do not add a theme toggle unless that is the task.

No custom spacing scale. Tailwind's default steps, used in multiples of 2
(`gap-2`, `mt-4`, `p-6`).

---

## 2. Component inventory

`apps/web/src/components/ui/` — shadcn primitives, unmodified:

`alert` `alert-dialog` `badge` `button` `card` `checkbox` `collapsible` `command`
`dialog` `dropdown-menu` `form` `input` `label` `popover` `radio-group` `select`
`separator` `skeleton` `sonner` `switch` `table` `tabs` `textarea`

`apps/web/src/components/` — project primitives. Prefer these over re-inventing:

| Component | Use for |
|---|---|
| `civil-date-input` | **Every** civil date. Calendar-aware (Gregorian/BS). Never use a bare `<input type="date">`. |
| `combobox` | Searchable single-select over a list (tenant, unit, property pickers). |
| `confirm-delete-dialog` | Destructive confirmation with a typed/explicit acknowledgement. |
| `copy-button` | One-shot copy of a token or link (e.g. the invite link shown once). |
| `ErrorBoundary` | Route-level crash containment. |
| `layout/AppShell` | The one signed-in chrome, landlord and tenant both. |

Need something shadcn ships that isn't here:
`pnpm --filter web dlx shadcn@latest add <name>`. Do not hand-roll it.

**Note what is absent**, because it shapes what you can propose cheaply: no
sidebar, no data-table (sorting/column/bulk-selection) component, no pagination
component, no tooltip, no sheet/drawer, no toggle-group, no date-range picker, no
chart library. Proposing any of these means proposing an installation — say so and
price it.

---

## 3. Layout patterns in use

```tsx
// List page
<main className="mx-auto max-w-5xl p-6">
  <div className="flex items-center justify-between">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Title</h1>
      <p className="mt-1 text-sm text-muted-foreground">One line of what this is.</p>
    </div>
    <Button><Plus /> Primary action</Button>
  </div>
  <div className="mt-6">{/* skeleton | error | empty | table */}</div>
</main>
```

- **List pages**: `max-w-5xl`. **Detail pages**: `max-w-4xl` with a back link
  (`<ArrowLeft/> All leases`) above the header.
- **Detail header**: `h1` + status `<Badge>` + a balance chip on one row; a muted
  subtitle line of context beneath; actions right-aligned in a
  `flex shrink-0 flex-wrap justify-end gap-2` cluster, conditioned on status.
- **Tabs** segment a detail page's panels (`LeaseDetailPage`). Panels live in their
  own components (`LedgerPanel`, `LeaseRosterPanel`).
- **Dialogs** carry every mutation — 20 of them today
  (`*FormDialog`, `*Dialog` per verb). The established rule: a mutation that needs
  more than a confirmation but less than a wizard is a dialog. Only lease creation
  earned a full page (`/leases/new`, `wizard/`).
- **Banners** for state the user must notice but can dismiss (`DriftBanner`), with
  `lib/use-dismissed.ts` persisting the dismissal.
- Toasts via `sonner` for mutation success. Do not toast a navigation.

**Responsiveness is thin today.** Only `sm:` appears, mostly for dialog widths and
form grids; no list page has a single responsive class, so every table overflows on
a phone. Landlord screens are laptop-first and that is defensible; the **tenant
portal is not** — tenants arrive on phones. Design portal screens mobile-first and
say so.

---

## 4. Data, forms and state

- Fetching: TanStack Query via `lib/api.ts`'s typed `request()`. Hooks live in each
  feature's `api.ts`. **No bare `fetch` in a component.**
- Responses are parsed through the contract's Zod schema; a mismatch throws
  `ApiClientError`. Branch on `error.code`, never on message text.
- Forms: `react-hook-form` + the contract's own Zod schema as resolver
  (`@hookform/resolvers`). One schema validates the form and the request. Server
  field errors come back in `details` — wire them with `lib/form-errors.ts`.
- Money: `formatMoney(cents, currency)` from `@rms/contract`. Input via
  `features/units/RentInput` + `features/units/money.ts`. Cents only.
- Dates: `formatCivilDate` from `lib/format-civil-date.ts` for display,
  `civil-date-input` for entry. **No date arithmetic in `apps/web`** — there is a
  guard test (`src/no-date-arithmetic.guard.test.ts`) that fails the build.
- Lists paginate by cursor via `useInfiniteQuery`; `items = data.pages.flatMap(...)`.

---

## 5. Copy and labels

Enum labels are **centralised in the contract** and imported, never retyped:
`leaseStatusLabels`, `rentFrequencyLabels`, `propertyTypeLabels`, `endReasonLabels`,
`formatAddress`, `formatMoney`.

Badge variant per enum value is mapped once per feature in a `*-ui.ts` file
(`lease-ui.ts`, `charge-ui.ts`, `payment-ui.ts`) so a status never gets two colours.
**Adding a status or type means editing that map**, not inlining a variant.

Copy voice, as established:
- Sentence case everywhere. Buttons are verbs: `Add property`, `Record payment`,
  `End lease`.
- Descriptions state a fact, not a feature: *"Every tenancy with unpaid, past-due
  rent — deposits are tracked separately and never counted here."*
- Plural-aware counts (`1 tenancy` / `3 tenancies`).
- Never expose an internal term the landlord doesn't use. "Chain" is internal;
  on screen it is "tenancy".

---

## 6. The four states — non-negotiable

`docs/ARCHITECTURE.md` §8 and `.claude/agents/frontend-dev.md` both require every
screen to handle:

1. **Loading** — `<Skeleton>` shaped like the real layout. Not a spinner where the
   layout is known.
2. **Empty** — two different empties. *Nothing exists yet* explains the concept and
   offers the creating action. *Filters matched nothing* offers to clear them.
   `ArrearsPage` does this correctly; copy its shape.
3. **Error** — says what failed and offers `onRetry={() => void refetch()}`.
4. **Loaded**.

Plus, in this domain: voided rows (struck through, still visible), truncated
results, multi-currency groups that must never be summed, credit balances, prorated
first/last periods ("17 of 31 days"), and ended tenancies that still owe.

---

## 7. Accessibility floor

Enforced by convention, and checked in review:

- Every input has a `<Label htmlFor>`; icon-only controls have `aria-label`.
- Decorative icons get `aria-hidden="true"` — the codebase is consistent about this.
- Keyboard: everything reachable by Tab, visible focus (`outline-ring/50` is the
  base ring), Escape closes dialogs, focus returns to the trigger on close.
- Errors announced via `aria-live`; loading regions marked `aria-busy`.
- Current nav item marked with `aria-current`, not colour alone.
- Status is never conveyed by colour alone — badge text carries the meaning.
- Row links: the cell content is the `<a>`, so the target is real and middle-click
  works. Do not replace a link with a row `onClick`.
