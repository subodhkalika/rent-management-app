# Task 008 (frontend) — Phase 3a: charges UI

**Agent:** frontend-dev · **Owns:** `apps/web/**` · **Contract:** FROZEN at 335e5ed

Read `docs/PLAN-PHASE3A.md` §§3.6, 8, 9, 11 first.

> The number the browser previews and the number in the charge row are produced by
> the same call to `buildSchedule`, through the same `billingTermsFor` adapter. There
> is no second implementation and there must never be one. If they ever disagree, the
> charge row is right and the preview is stale — never the other way round.
>
> A charge row, once written, is never updated and never deleted. The only mutation
> `charge` accepts is the void tombstone, and a correction is a superseding row.

## Screens

1. **Charges tab on `LeaseDetailPage`** — ordered by due date. Overdue via
   `chargeOverdue(dueDate, localToday(propertyTimezone))`, never the browser's clock:
   a charge is not late because the viewer is in a different timezone. Voided rows
   struck through, not hidden, with their successor linked.
2. **Void and correct dialogs** — reason is mandatory and at least ten characters, the
   same validation the rent-step correction dialog already uses. Plus a manual-charge
   dialog for late fees, utilities and the like.
3. **The drift banner** — all four kinds from `diffChargesAgainstSchedule`, each with
   its own action: amount and due_date offer review-and-supersede, missing offers
   "run generation", unscheduled offers "void it". Assert against
   `chargeDriftFixtures`. This is the only thing that makes a rent-step correction
   visible, because the generator never rewrites a row that already exists.
4. **`ActivateLeaseDialog` gains a generation preview** — "Activating creates N
   charges totalling X; M are already overdue", computed client-side from
   `buildSchedule`. This is the guard-rail for the most alarming thing a new user can
   do by accident: onboarding a six-month-old tenancy and getting seven charges at
   once, six already overdue. That behaviour is correct and intended; being surprised
   by it is not.
5. **`/charges`** — portfolio-wide, with property, unit and date filters and an
   overdue-only toggle. **Group by currency, never sum across them.**
6. **`/portal/leases/:id` charge list** — prorated rows show "17 of 31 days", voided
   rows struck through. **No totals**: a total without payments changes meaning in 3b,
   and telling a tenant they owe $4,500 when they have paid $4,500 is worse than
   showing nothing.

Four states on every screen, as always.

## Done when

typecheck, lint and tests pass.
