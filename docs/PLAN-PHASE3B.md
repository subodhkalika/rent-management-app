# Phase 3b — Payments, Allocation, Balances, Arrears

Status: plan. Written 2026-10-10, on top of PLAN-PHASE3A (charges, void/correct,
cron) as shipped.

**Scope.** Manual payment recording, FIFO allocation, per-lease and per-chain
balances, the arrears view, and the tenant's own payment history and balance.
**Not** reminders, **not** maintenance, **not** reports, **not** card processing —
nothing here leaves the free tier.

---

## 0. The ten decisions

| # | Decision | One-line reason |
|---|---|---|
| 1 | **Allocation is chain-wide, not lease-wide.** The FIFO partition is `lease.chain_id`. | A renewal is the same tenancy; money paid under lease B must settle lease A's shortfall, or every rent change mid-tenancy creates a phantom debt and a phantom credit at once. |
| 2 | **One window function, parameterised by scope**, in `repo/ledger.ts`. The ledger, the balance and the arrears page all call it. | Three callers, one definition of "paid"; a second implementation is how a ledger and a dunning email disagree. |
| 3 | **`ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`, never `RANGE`.** | The default frame groups peers, so a deposit and a first rent sharing one due date would both see the same `prior` and both get paid. Reachable on day one. |
| 4 | **Every aggregate is cast `::bigint`.** | `SUM(bigint)` returns `numeric`, which the Neon driver hands back as a *string*; `applied_cents` would arrive as `"1000"` and the first arithmetic on it is `NaN`. The most likely day-one 3b bug. |
| 5 | **Void means "it never happened"; refund means "it happened and I sent money back".** | Two verbs, two meanings, no overlap — bounced cheque is a void, returned overpayment is a refund. |
| 6 | **Returning a deposit = void the deposit charge + record a refund** (+ an optional damage charge). | A bare refund would re-open the *newest* charges under FIFO, making last month's rent look unpaid. Cancelling the obligation and returning the money nets to exactly zero with no new mechanism. |
| 7 | **Two balance buckets: deposit, and everything else.** | Chasing an unpaid deposit is a different conversation from chasing arrears; late fees and utilities are arrears-like. A third bucket changes no decision. |
| 8 | **Arrears = unpaid remainder on non-deposit charges whose `due_date` is already past *in the property's timezone*.** | Computed in SQL with the same `(now() at time zone property.timezone)::date` expression `overdueOnly` already uses — one rule, not two. |
| 9 | **No pagination on the ledger or the arrears page.** Hard caps with a `truncated` flag. | A running balance that restarts on page 2 is wrong, and a chain has tens of rows, not millions. |
| 10 | **Earmarking a payment to a specific charge is rejected, not deferred.** | The moment a payment can name a charge, FIFO stops being the single source of truth and the system needs a reconciliation screen it will never earn. |

---

## 1. Stale statements in 3a and V1 that 3b must not inherit

`GENERATION_LOOKAHEAD_DAYS` is now **0**. A charge is written on the first day of its
own period; a landlord bills ahead only by explicit action, via
`chargesThroughNextPeriod` / `POST /leases/:id/charges/generate-next-period`.
Everything below describes behaviour that no longer exists.

| Where | What it says | Status |
|---|---|---|
| 3a §3.4, and `repo/charge.ts:291`'s comment | "Charges are written up to `GENERATION_LOOKAHEAD_DAYS` ahead of today", and the rent-step mutability boundary derived from that window. | **Vacuous, not wrong.** With a 0-day window the boundary collapses to exactly `latestChargedPeriodStart`. The code still computes the right answer; the comment now explains a window of zero width. Reword, do not restructure. |
| 3a §3.6 / `charge.ts`'s `diffChargesAgainstSchedule` comment | `unscheduled` arises "when a lease is ended after the lookahead already wrote past the new end". | **Stale cause, live kind.** The generator can no longer write past today, so `unscheduled` now arises only from `generate-next-period` or from a lease end date moved earlier. Keep the kind; fix the sentence. |
| 3a §10 | `generationPlanFixtures` derives `today` as `addDays(through, -GENERATION_LOOKAHEAD_DAYS)`. | **Now the identity function.** Harmless, but it reads as if a window were being subtracted. Say so in the fixture file or a future reader will hunt for the offset. |
| 3a §9.1 correction 2 | "The manual kick is *exactly* the cron's work for one lease." | **True of `/generate`, false of `/generate-next-period`,** which ships and deliberately writes one period further than the cron ever would. The invariant worth keeping is narrower: *the cron's own horizon is a function of `(terms, today)` alone*. |
| V1 §4.6 and 3a §12 | `charge_lease_due_idx on (org_id, lease_id, due_date, id)` is "**exactly**" the FIFO window's `ORDER BY`. | **Overstated under decision 1.** See §3.4: it is the right *access path* and no new index is needed, but it does not supply pre-sorted order for a chain-wide window. |
| V1 §3.5 | `POST /v1/leases/:id/payments` returns `409` on "currency mismatch". | **Unreachable — delete it.** The client never sends a currency; the repo copies `lease.currency` at write, exactly as `createManualCharge` already does. There is nothing to mismatch. |
| V1 §3.5 | `PATCH /v1/payments/:id`, `POST /v1/payments/:id/void`, `/correct` — bare payment ids. | **Nest them under the lease,** per 3a §9.1 correction 1. One extra conjunct, zero ambiguity about whether a bare id was scoped. |
| V1 §4.6 | The FIFO sketch itself. | Four corrections — see §3.2. |

**The one behavioural consequence 3b inherits from the lookahead change:** a payment
arriving *before its charge exists* is no longer an edge case, it is the normal
experience of every tenant who pays a few days early. V1 filed it under "edge cases
that fall out"; in 3b it is the main path and it gets a first-class UI answer (§4,
row 3).

---
## 2. The `payment` table

3a's money-table shape is **confirmed**, with four differences from `charge` that are
each a consequence of one fact: *no machine ever writes a payment.*

### 2.1 Enums

```ts
export const paymentKindEnum = pgEnum('payment_kind', ['payment', 'refund']);
export const paymentMethodEnum = pgEnum('payment_method', [
  'bank_transfer', 'cash', 'cheque', 'card_external', 'upi', 'other',
]);
```

Both kinds are stored **positive** and signed at read — a negative amount in a money
table is a landmine for every `SUM` written later. `upi` ships now for the same
reason 3a shipped all six charge types: `ALTER TYPE … ADD VALUE` is awkward enough
that the complete vocabulary is cheaper up front, and `INR` is already a supported
currency. `card_external` means a card payment taken through someone else's
processor and recorded here — there is no card processing in this product.

### 2.2 `payment`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `uuidv7()` |
| `org_id` | `text` NOT NULL FK → organization, **cascade** | same as `charge` |
| `lease_id` | `uuid` NOT NULL FK → lease, **`on delete restrict`** | same as `charge`; a payment must outlive every lease-deletion path |
| `kind` | `payment_kind` NOT NULL | |
| `method` | `payment_method` NOT NULL | |
| `amount_cents` | `bigint({ mode: 'number' })` NOT NULL | **CHECK `> 0`** — see §2.4 |
| `currency` | `text` NOT NULL | copied from `lease.currency` at write; never accepted from the client; immutable |
| `received_on` | `date` NOT NULL | the **property's** local date, not the landlord's browser date — §2.5 |
| `reference` | `text` NULL | cheque number, bank ref. **Immutable: it is evidence.** 1..200 chars |
| `note` | `text` NULL | **the only mutable field.** Private bookkeeping, 0..1000 chars |
| `supersedes_payment_id` | `uuid` NULL FK → payment, restrict | correction chain, self-referencing |
| `voided_at` | `timestamptz` NULL | |
| `voided_reason` | `text` NULL | 10..500, enforced by the contract |
| `voided_by_user_id` | `text` NULL FK → user | |
| `recorded_by_user_id` | `text` **NOT NULL** FK → user | differs from `charge.created_by_user_id` |
| `created_at` | `timestamptz` NOT NULL default now | |
| `updated_at` | `timestamptz` NOT NULL default now | differs from `charge` — §2.3 |

**Not denormalised, deliberately:** `chain_id`, `charge_id`, `tenant_id`. `chain_id`
for 3a's reason (a re-chain would need a backfill). `charge_id` because decision 10.
`tenant_id` because a payment settles a *lease's* obligation and co-tenants are
jointly liable — recording who handed the money over is what `note` and `reference`
are for, and promoting it to a column invites a per-tenant balance that does not
exist.

### 2.3 The four differences from `charge`, each with its reason

| | `charge` | `payment` | Why |
|---|---|---|---|
| Mutable fields | none | `note` | A charge's `description` is the line the tenant reads on their statement — changing it changes the document. `note` is never shown to a tenant, so it is the landlord's own margin. **Confirmed, not challenged.** |
| `updated_at` | absent, deliberately | **present** | 3a's rule was "a table with no mutable field must not have one; its presence would be an invitation". The converse is the same rule: `payment` has exactly one mutable field, so it carries `updated_at`, and the presence of the column is the signal that something here can change. |
| Who wrote it | `created_by_user_id` **nullable** — NULL means the generator | `recorded_by_user_id` **NOT NULL** | Nothing automated records a payment. A NULL here would be unexplainable, so the constraint says so. |
| `generation_key` / idempotency | `charge_generation_uq` | **none** | There is no idempotency key and there must not be one. Two identical cash payments of $50 on the same day are two real events, and a unique index would silently drop the second. Double-entry is prevented in the UI (a confirm step when an identical amount/date/method already exists on the lease), never in the schema. |

Everything else is identical and on purpose: append-only, void is the only
state transition, a correction is a superseding row with
`supersedes_payment_id`, never an edit.

### 2.4 `amount_cents > 0`, not `>= 0`

The opposite of 3a §1.5, and for the opposite reason. 3a needed `>= 0` because the
*generator* can legitimately emit a zero (a prorated rent rounding down), and a
23514 on the 09:00 cron would be an unhandled 500. Nothing generates a payment, and a
$0 payment is not an event — it is a mis-click. So:

- the CHECK is `> 0`;
- the contract's `paymentAmountCents` is `money.refine(v => v > 0)`, so the CHECK is
  unreachable through the API and the user gets a 422 with a field message;
- **and `lib/db-errors.ts` gains a `23514` branch mapping to `422`.** Today it knows
  only `23505`, which is exactly how 3a predicted a CHECK violation would surface as
  a 500. 3b adds two CHECKs to the system; close the gap while adding them.

### 2.5 `received_on` is the property's local date

One timezone question exists in this system — *what is today, where the property is*
— and `common.ts` already says so. A landlord in Sydney recording a payment for a
London flat on the London tenant's Friday must not file it on Saturday.

- The dialog defaults `receivedOn` to `localToday(property.timezone)`, not to the
  browser's date.
- The route rejects `receivedOn > (now() at time zone property.timezone)::date`
  with **422**. A payment received tomorrow is a typo, and a future-dated payment
  silently inflates a balance.
- There is **no lower bound**. A deposit paid at signing predates `start_date`, and
  an onboarded tenancy has payments predating `ledger_start_date`. Both are real.
- `received_on` is a `date`, never a `timestamptz`. DST cannot move a date.

### 2.6 Indexes

```ts
// The ledger, the payment list, and the FIFO net-paid aggregate (leading
// (org_id, lease_id) serves the chain aggregate once per lease in the chain).
index('payment_lease_received_idx').on(t.orgId, t.leaseId, t.receivedOn, t.id),
```

**One index. That is all 3b queries.** Deliberately NOT added:

- `payment_org_received_idx on (org_id, received_on)` — V1 wants it for the income
  report and the CSV export. 3b ships neither. Index what you query.
- Anything on `kind`, `method` or `voided_at`. A lease has tens of payments; the
  filter is a predicate on an already-tiny result set.

### 2.7 Migration

One migration, additive, no backfill, no multi-step: two new enums, one new empty
table, one new index. **No existing table changes.** `charge`, `lease` and every
Phase 2 table are untouched by 3b's schema. The only non-schema change to an existing
table's *rules* is `hardDeleteLease` gaining a zero-payment precondition (§4, row 10).

---
## 3. FIFO allocation: one window function, derived, never stored

### 3.1 The scope: the chain, not the lease

**The FIFO partition is `lease.chain_id`.**

A renewal is the same tenancy under a new rent. If allocation stopped at the lease
boundary, a tenant who moved onto lease B owing $200 from lease A would show, forever,
as $200 in arrears on a dead lease and $200 in credit on a live one — two wrong
numbers whose sum happens to be right. Chain-wide FIFO makes the single most awkward
money case in the product ("rent changed mid-tenancy") fall out of the ordering
instead of needing a reconciliation rule.

Two consequences, both of which must be stated out loud:

1. **It does not matter which lease in a chain a payment is recorded against.** The
   UI records against the lease on screen. Financially it is the same money. Saying
   so removes an entire class of user error.
2. **`chain_id` must mean "one tenancy".** It does today only by convention.
   §13 asks for one Phase-2 behaviour change — `renew` requires at least one tenant
   in common with its predecessor — to make it mean it by construction.

A chain is also the unit of currency safety: see §6.2.

### 3.2 The query

```sql
WITH scoped_lease AS (
  SELECT l.id, l.chain_id, l.currency
  FROM lease l
  WHERE l.org_id = $1
    AND (l.chain_id = $2)            -- org-wide form: drop this conjunct
),
net_paid AS (
  SELECT sl.chain_id,
         COALESCE(SUM(CASE WHEN p.kind = 'payment'
                           THEN p.amount_cents ELSE -p.amount_cents END), 0)::bigint
           AS total_cents
  FROM scoped_lease sl
  JOIN payment p
    ON p.lease_id = sl.id
   AND p.org_id   = $1
   AND p.voided_at IS NULL
  GROUP BY sl.chain_id
),
ordered AS (
  SELECT c.id, c.lease_id, sl.chain_id, c.type, c.due_date, c.amount_cents,
         COALESCE(SUM(c.amount_cents) OVER (
           PARTITION BY sl.chain_id
           ORDER BY c.due_date, c.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0)::bigint AS prior_cents
  FROM charge c
  JOIN scoped_lease sl ON sl.id = c.lease_id
  WHERE c.org_id = $1
    AND c.voided_at IS NULL
)
SELECT o.id, o.lease_id, o.chain_id, o.type, o.due_date, o.amount_cents,
       GREATEST(0::bigint,
                LEAST(o.amount_cents,
                      COALESCE(np.total_cents, 0::bigint) - o.prior_cents)
       )::bigint AS applied_cents
FROM ordered o
LEFT JOIN net_paid np ON np.chain_id = o.chain_id
ORDER BY o.due_date, o.id;
```

**The ordering key is `(due_date, id)`.** Not `created_at` — a charge raised today
for a period last March must settle before this month's rent, or a landlord who
back-bills a utility watches it jump the queue. Not `period_start` — it is NULL on
deposits, opening balances and every manual charge, and NULLs would sort as a block.
`id` is `uuidv7`, so the tiebreak is insertion order, which is stable, total, and the
same tiebreak the ledger page and the cursor already use.

### 3.3 Five corrections to PLAN-V1 §4.6's sketch

| # | V1 sketch | Correction |
|---|---|---|
| 1 | `WHERE org_id = $1 AND lease_id = $2` | Chain scope via `scoped_lease` (§3.1). `org_id` stays the first conjunct on all three tables — `lease`, `payment` and `charge` are each independently org-filtered, so a forged `chain_id` from another org matches zero leases and the whole query returns empty. |
| 2 | default window frame (none stated) | **`ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`, explicitly.** Postgres's default for an `ORDER BY` window is `RANGE UNBOUNDED PRECEDING AND CURRENT ROW`, which groups *peers*: two charges with the same `due_date` would each see the other's amount in `prior` — or, with `CURRENT ROW`, their own. A deposit (`due_date = lease.start_date`) and a first prorated rent routinely share a due date, so this is not a theoretical frame-semantics point; it double-applies money on the very first lease anyone tests. **This single clause is the most load-bearing token in 3b.** |
| 3 | `SELECT c.*` | An explicit column list. `charge` has 24 columns; `c.*` inside a CTE makes the result shape depend on physical column order, and the ledger maps these rows into `ChargeRow`. |
| 4 | aggregates uncast | **`::bigint` on every aggregate.** `amount_cents` is `bigint({ mode: 'number' })`, but `SUM(bigint)` in Postgres returns **`numeric`**, and `numeric` comes back through the Neon HTTP driver as a *string*. Without the cast, `applied_cents` arrives as `"100000"`, `balance - applied` is `NaN`, and the balance renders as `$NaN` — passing every type check on the way, because the contract field is typed `number` and nothing re-validates a server-side row. Cast in SQL **and** `Number()` in the repo mapper **and** a test asserting `typeof row.appliedCents === 'number'`. |
| 5 | `(SELECT total FROM paid)` scalar | `LEFT JOIN net_paid … COALESCE(np.total_cents, 0)`. V1's inner-join/scalar form drops a chain that has charges and no payments — i.e. every tenant who has not paid yet, i.e. exactly the rows the arrears page exists to show. |

### 3.4 How a void drops out, and whether 3a's index serves

- **A voided charge** drops out at `ordered`: `c.voided_at IS NULL`. It is not in the
  partition at all, so it contributes nothing to `prior_cents` and every later charge
  shifts up. That is the whole implementation of "void a charge and the money it
  consumed is freed".
- **A voided payment** drops out at `net_paid`: `p.voided_at IS NULL`. `total_cents`
  falls, and allocation retreats from the newest charges backwards. That is the whole
  implementation of "bounced cheque".
- **A correction** needs no rule of its own. The original is voided (out), the
  successor is live with its own `id` and `due_date` (in). Correction is void plus
  insert, and FIFO only ever sees live rows.
- **A voided charge still needs an `applied_cents` for display**, because
  `includeVoided` defaults to `true` and the ledger strikes voids through rather than
  dropping them. The ledger's outer select is therefore a `LEFT JOIN` from *all*
  charges onto the `ordered` CTE: no match → `applied_cents = 0`, status `void`.
  Do not "fix" this by including voids in the CTE.

**Does `charge_lease_due_idx on (org_id, lease_id, due_date, id)` serve?**
**Yes as the access path, no as the sort.** 3a §12 claims it is "*exactly* the
window's `ORDER BY`", which was true of a lease-scoped FIFO and is overstated for a
chain-scoped one: the window orders across several `lease_id`s, so the index's
leading `lease_id` cannot supply the order and Postgres adds a Sort node. It is still
the right index — it is how all of the chain's charges are fetched, one index range
per lease — and the sort is over **tens of rows**. *No new index. Do not add
`chain_id` to `charge` to chase this.* At tens of units a sort of 120 rows is free,
and the denormalised column would need a backfill the first time a lease is
re-chained, which is 3a's own stated reason for leaving it off.

### 3.5 Derived status, and the zero-amount trap

Never a column, never an enum on the table. One contract function, used by both apps:

```ts
chargeStatus = z.enum(['void', 'paid', 'partially_paid', 'overdue', 'unpaid'])
chargeStatusFor({ amountCents, appliedCents, dueDate, isVoided, today })
```

Precedence, in order, and the order matters:

1. `isVoided` → `void`
2. `appliedCents >= amountCents` → `paid` — **`>=`, not `===`**
3. `appliedCents > 0` → `partially_paid`
4. `dueDate < today` → `overdue`
5. otherwise → `unpaid`

Rule 2 is `>=` specifically so that **a zero-amount charge is `paid`**. 3a's
`amount_cents >= 0` exists so the generator can write a zero-rent period (a caretaker
lease, a proration that rounds to nothing). With `===` that row is fine; with the
checks in the wrong order a `0`-amount, past-due charge reads `overdue`, and a
zero-rent lease shows **permanent, unclearable arrears that no payment can ever
settle**. Pin it with a fixture.

`today` is `localToday(property.timezone)` — 3a's `chargeOverdue` already owns this
rule and `chargeStatusFor` delegates to it rather than re-comparing dates.

### 3.6 The reference implementation, and why it is not the server's

`ledger.ts` in the contract exports a pure function:

```ts
allocateFifo(input: {
  charges: readonly { id, dueDate, amountCents, type, isVoided }[];
  payments: readonly { kind, amountCents, isVoided }[];
}): { chargeId: string; appliedCents: number }[]
```

It is **not** what the API runs. The SQL in §3.2 is the source of truth; the server
never allocates in TypeScript. `allocateFifo` exists for exactly two jobs:

1. **The test oracle.** `allocationFixtures` in `ledger.fixtures.ts` is a table of
   worked cases; the API's integration test asserts the SQL's output equals
   `allocateFifo`'s over the same data, and the contract's unit test asserts
   `allocateFifo` equals the fixture. SQL and spec cannot drift silently.
2. **The web's optimistic preview** — "recording this $1,200 will clear March and
   part of April" in the record-payment dialog, before the round trip.

If they ever disagree, **the SQL is right and the preview is stale**, the same
sentence 3a froze about `buildSchedule`.

---
## 4. Every money edge case, falling out of the allocation

The test of this design is that the "Mechanism" column is almost always *none*.

| # | Case | What the landlord does | Mechanism |
|---|---|---|---|
| 1 | **Partial payment.** Rent $1,000, tenant pays $600. | Records $600. | None. `applied = clamp(600 - 0, 0, 1000) = 600` → `partially_paid`. The next charge sees `prior = 1000 > 600` → `applied = 0`. |
| 2 | **Overpayment leaving a credit.** Charged $1,000, paid $1,500. | Records $1,500. | None. Every charge saturates at its amount; `balance = charged - net_paid = -500`. The UI reads the sign: **"Credit $500"**. `moneyDelta`, never `money` — see §5.4. |
| 3 | **A payment before its charge exists.** Tenant pays January on 28 December. | Records it on 28 Dec. Optionally presses **Bill next period now** (`generate-next-period`). | None. The credit sits; the moment January's charge is written — by the cron on 1 Jan, or by that button — it is born `paid`. **No unapplied-payments queue, ever.** With lookahead now 0 this is the common case, not an edge case, so the button is surfaced on the lease page next to a credit balance, labelled by the credit: *"Credit of $1,000 — bill next period now?"* |
| 4 | **Refund of an overpayment.** Tenant overpaid $300, landlord sends it back. | Records a `refund` of $300. | None. `net_paid` falls by 300, the credit goes to zero, no charge is touched because none was saturated by that 300. |
| 5 | **Correction to a wrong amount.** Recorded $1,200, it was $1,020. | `POST …/payments/:id/correct` with the right numbers and a reason. | Void + superseding insert, the identical mechanism `correctCharge` already ships. Both rows stay in the ledger, the void struck through, linked by `supersedes_payment_id`. **Void first, then insert** — 3a §4.4's ordering, for the same reason: a torn write leaves a visible hole rather than a moment where two live payments both count. |
| 6 | **Bounced cheque.** | `POST …/payments/:id/void` with a reason. No successor. | None beyond the void. `net_paid` falls, allocation retreats from the newest charge backwards, the arrears re-appear with the correct original `due_date` so "days late" is honest. A late fee, if the landlord wants one, is a manual `late_fee` charge — never automatic (V1 §7.2, jurisdictional). |
| 7 | **Void vs refund — the rule.** | — | **Void = "this never happened or I recorded it wrong." Refund = "it happened and I sent money back."** A bounced cheque is a void; a returned overpayment is a refund. Getting this backwards is the only way a landlord can make the ledger lie, so the dialogs say it in these words. |
| 8 | **Deposit and rent in one ledger.** Tenant transfers $3,000 covering a $2,000 deposit and $1,000 rent. | Records one $3,000 payment. | None. FIFO runs across all charge types in due-date order; the deposit (`due_date = lease.start_date`) is usually first. The *balance* splits deposit from the rest (§5.2), and arrears ignores the deposit bucket entirely. |
| 9 | **Returning the deposit at move-out.** | One UI action, **Return deposit**, which performs: void the deposit charge (reason prefilled "Deposit returned at move-out") **+** record a `refund`. | **This is the one recipe worth memorising.** A bare refund would be arithmetically correct and presentationally wrong: `net_paid` drops $2,000 and FIFO retreats from the *newest* charges, so last month's rent reads unpaid while the deposit still reads paid. Cancelling the obligation and returning the money nets to exactly zero and leaves both rows on the statement. **Partial retention** is the same recipe plus a manual `other` charge: void $2,000 deposit, refund $1,500, charge $500 damages → balance moves 0 → 0, and the ledger tells the story in three lines. |
| 10 | **Rent change mid-tenancy.** Lease A ends, lease B renews at a new rent; $200 outstanding on A. | Nothing. | §3.1. One partition, one queue; B's first payment clears A's $200 before it touches B's rent. Without chain-wide FIFO this is the case that needs a special rule, and the special rule is where the bug lives. |
| 11 | **Lease ends with money owed.** | `/end` as today. | Nothing. The chain balance survives the lease's status; the arrears page keys on chains, not on `status = 'active'`, so a debt does not vanish when the tenant moves out. A unit returning to `vacant` does not clear a balance and never touches `payment`. |
| 12 | **A deleted property with history.** | — | Unchanged from V1 §5.3, now also true of payments: property and unit are **soft**-deleted; `lease`, `charge` and `payment` never cascade. `payment.lease_id` is `on delete restrict`, so the database refuses rather than loses. |
| 13 | **Hard-deleting a lease.** | — | 3a gave `hardDeleteLease` a zero-charge precondition; **3b adds the zero-payment half.** Both are `409`. One `EXISTS` each; cheap, and the FK would otherwise throw a raw 23503 as a 500. |
| 14 | **A refund larger than everything ever received.** | Blocked. | **409**, the one guard in 3b that is not derived: a refund may not take the chain's `net_paid` below zero. It catches the double-refund and the "I refunded the deposit twice because the first one did not seem to do anything". It is a read-then-write and therefore not race-safe; that is acceptable (a landlord is one person) and harmless if it loses, because `GREATEST(0, …)` clamps the allocation regardless. |
| 15 | **Two identical cash payments on the same day.** | Allowed. | They are two real events. There is deliberately **no** unique index (§2.3). The UI asks "you already recorded $50 cash on 3 March — record another?" — a confirm step, never a constraint. |
| 16 | **Voiding a charge a payment had settled.** | Allowed, as 3a decided. | 3a §13 defaulted to "yes, with no extra guard, because 3b's FIFO turns the payment into a credit". **3b confirms it.** Nothing needed. |
| 17 | **A zero-amount rent charge.** | — | §3.5 rule 2's `>=`. Born `paid`, never `overdue`. |
| 18 | **Mixed currencies.** | — | §6.2. Arithmetic never crosses a currency; the responses are shaped so that a careless client *cannot* sum across one. |

---
## 5. Balances

### 5.1 Five numbers, and the identity that ties them

Over a chain, from the §3.2 result set:

| Name | Definition | Sign |
|---|---|---|
| `chargedCents` | `Σ amount_cents` over live charges | ≥ 0 |
| `paidCents` | `net_paid.total_cents` (payments − refunds, live only) | ≥ 0 in practice, clamped by the §4.14 guard |
| `outstandingCents` | `Σ (amount_cents − applied_cents)` | ≥ 0 |
| `creditCents` | `GREATEST(0, paidCents − chargedCents)` | ≥ 0 |
| `balanceCents` | `chargedCents − paidCents` **= `outstanding − credit`** | **signed** |

That identity is the whole point and it must be a test. `outstanding` and `credit`
are never both non-zero: money is applied greedily, so a credit exists only once
every charge is saturated.

- **Positive `balanceCents` = the tenant owes.** Negative = the landlord holds a
  credit. The UI branches on the sign; the contract exports
  `splitBalance(balanceCents) → { owedCents, creditCents }` so "Credit of $500" is
  worded identically in the landlord app and the portal.
- `balanceCents` is **`moneyDelta`**. `money` is `.nonnegative()`, so typing a
  balance with it would make every credit fail response validation in
  `apps/web/src/lib/api.ts` — V1 called this "the most likely day-one Phase 3 bug";
  `moneyDelta` and `moneyTotal` already exist in `common.ts` and 3b is the first
  phase that actually needs them.
- The four non-negative aggregates are **`moneyTotal`**, not `money`: `money` caps a
  single amount at $1M, and a ten-year chain's `chargedCents` legitimately exceeds it.

### 5.2 Where the deposit split matters — and where it does not

Two buckets, per decision 7:

- `depositOutstandingCents` — `Σ (amount − applied)` over `type = 'deposit'`
- `rentOutstandingCents` — `Σ (amount − applied)` over **everything else**: `rent`,
  `opening_balance`, `late_fee`, `utility`, `other`

"Rent" here means *obligations arising from living there*. A late fee and an unpaid
water bill are arrears-like — a landlord chases them the same way, in the same
message. An unpaid **deposit** is a different conversation ("you have not paid your
bond"), often at a different moment in the relationship, and it is the one bucket
that must not make a tenant look like a non-payer.

| Where the split matters | Which number |
|---|---|
| **Arrears** — the "who is behind" page and, in Phase 4, who gets chased | `rentOutstandingCents`, further restricted to past-due (§6.1) |
| Move-out checklist, "is the bond settled" | `depositOutstandingCents` |
| The lease header chip, the tenant's portal headline, the one number on a card | `balanceCents` (signed, both buckets) |
| **Anywhere a credit is shown** | `creditCents` — chain-level only. A credit is not attributable to a bucket and must never be split. |

### 5.3 Per lease and per chain

The allocation is chain-wide; the *reporting* has two slices.

- **Per chain** — the real financial position of the tenancy. Carries all five
  numbers, plus `arrearsCents`, `oldestOverdueDueDate`, and the chain's lease list.
- **Per lease** — the chain's allocation restricted to one lease's charges:
  `rentOutstandingCents`, `depositOutstandingCents`, `outstandingCents`,
  `arrearsCents`. **No `creditCents` and no `balanceCents` on the lease slice.** A
  credit belongs to the tenancy, not to a lease, and a signed per-lease balance would
  be a number that does not sum to the chain's — which is precisely the phantom
  credit chain-wide FIFO exists to abolish.

`GET /v1/leases/:id/balance` returns both slices in one response, so the lease page
can show "This lease: $400 outstanding · Tenancy: $600 outstanding" without a second
call, and so a landlord looking at lease B is never surprised by lease A's $200.

### 5.4 Computed where

In SQL, in `repo/ledger.ts`, from the §3.2 CTE plus `SUM(...) FILTER (WHERE ...)`.
Not in TypeScript over a fetched ledger: the arrears page needs the same aggregate
over every chain in the org at once, and computing it twice — once in SQL for the
list, once in TS for the detail — is how two screens come to disagree about one
tenant. One builder, three callers (§3.6 names the only TS implementation and its
two non-production jobs).

---

## 6. The arrears view

### 6.1 What makes a lease "in arrears"

> **`arrearsCents > 0`**, where
> `arrearsCents = Σ (amount_cents − applied_cents)` over **live, non-deposit**
> charges whose `due_date < (now() at time zone property.timezone)::date`.

Three things this gets right, each by construction rather than by a rule:

- **Not-yet-due rent is not arrears.** With `GENERATION_LOOKAHEAD_DAYS = 0` a charge
  appears on the first day of its own period, but `due_date` can be later in that
  period (`billingDay`). A tenant who has not yet paid rent that is not yet due is
  not behind. `outstandingCents` includes them; `arrearsCents` does not. These two
  numbers are different on purpose and the UI must not conflate them.
- **FIFO already put the shortfall in the right place.** Money lands on the oldest
  charges, so an unpaid remainder naturally accumulates on the newest ones — and the
  newest ones are the most likely to be not-yet-due and therefore excluded. A tenant
  one month behind shows exactly one month of arrears, not two.
- **A credit can never produce arrears.** A credit exists only when every charge is
  saturated, so every term in the sum is zero.

Also reported per chain: `oldestOverdueDueDate` — the earliest `due_date` with a
non-zero remainder. That, not the balance, is what tells a landlord whether this is
*"three days late"* or *"four months gone"*, and it is the column the page sorts by
in Phase 4's reminder scan.

**Keyed on chains, not leases.** The row's identity is the tenancy; it displays the
chain's *current* lease (latest `start_date`) for the unit, property and primary
tenant. A chain whose leases have all ended still appears — a departed tenant who
owes money is exactly who the page is for. There is **no** `status = 'active'`
filter and adding one would quietly hide the worst debts.

`minCents` query param, default `1`. A landlord with a $0.02 rounding remainder does
not want a dunning row; raising it to e.g. `500` is one click.

### 6.2 Currencies: how it stays correct without ever summing across them

Three layers, so no single mistake is sufficient.

1. **A chain holds exactly one currency.** `lease.currency` is immutable per lease
   and `charge.currency` is copied from it at write, but a *renewal* creates a new
   lease and nothing today stops it carrying a different currency. **`renewLease`
   must reject a currency change with 409** (§13). Belt and braces:
   `repo/ledger.ts` asserts `COUNT(DISTINCT currency) = 1` over `scoped_lease` and
   throws a `conflict` rather than summing — a loud, specific failure beats a
   plausible wrong total.
2. **The response is grouped by currency at the top level**, not flat with a
   currency column:
   ```ts
   arrearsResponse = { groups: [{ currency, chainCount, totalArrearsCents, rows }],
                       truncated: boolean }
   ```
   There is no shape in which a client can accidentally sum across currencies,
   because there is no array that contains two of them. This is the same decision
   the `/v1/charges` page already made; 3b keeps it rather than inventing a
   `convertedTotal` that would need an FX rate, a rate date, and a support ticket.
3. **No cross-currency total anywhere.** Not in the header, not in a sparkline, not
   in a CSV. A landlord with USD and INR properties sees two groups.

`?currency=` filters to one group when a landlord wants to work one book at a time.

### 6.3 Shape and cost

One query per request, org-scoped, the §3.2 window with the `chain_id = $2`
conjunct dropped and a `HAVING` on the aggregate. At the stated scale — tens of
landlords, hundreds of leases, tens of charges each — this is a few thousand rows
sorted in memory. **No pagination** (decision 9): `ARREARS_MAX_ROWS = 500` chains
with `truncated: true` when it bites, which it will not. Grouping and cursor
pagination do not compose, and faking it would be worse than the cap.

If this ever becomes slow, the fix is a materialised balance per chain refreshed by
the existing daily cron — **not** a cache, and **not** a stored allocation table.
Named here so nobody invents it early.

---
## 7. The tenant side

Separate types, never the landlord shape with fields removed — `portalCharge` is the
precedent and the reasoning is unchanged: a column added on the landlord side must be
structurally incapable of reaching a tenant by inheritance.

### 7.1 `portalPayment`

```ts
portalPayment = {
  id, leaseId,
  kind,                      // 'payment' | 'refund' — a refund they received is theirs to see
  method, amountCents, currency, receivedOn,
  reference: string | null,  // their own cheque number; evidence, and theirs
  isVoided: boolean,         // whether, not when or why
  supersedesPaymentId: uuid | null,
}
```

| Field | In portal? | Why |
|---|---|---|
| `note` | **No** | The single most important omission on this type. It is the landlord's private margin — *"paid late again, chase in person"* — and it is mutable precisely because it is not a document the tenant reads. |
| `voidedReason` | **No** | May be unflattering, may mention another tenancy. Same call as `portalCharge`. |
| `voidedAt` | **As `isVoided`** | They must see a line was cancelled or their history does not add up. The timestamp gives them nothing to act on. |
| `recordedByUserId`, `voidedByUserId` | **No** | Landlord staff identity. |
| `supersedesPaymentId` | **Yes** | So "$1,200 replaced by $1,020" reads as one correction, not two payments — exactly `portalCharge`'s reasoning. |
| `reference` | **Yes** | It is the tenant's own bank reference. Withholding the one field that lets them match a line to their statement would make the page useless for its main job. |
| `kind`, `method`, `amountCents`, `currency`, `receivedOn` | **Yes** | It is their history. |

Co-tenants see each other's payments. They are jointly liable for one obligation;
V1 §1.4 already settled this and 3b does not reopen it.

### 7.2 `portalBalance`

```ts
portalBalance = {
  leaseId, currency,
  asOfDate: isoDate,              // localToday(property.timezone), server-computed
  outstandingCents: moneyTotal,   // billed and unpaid, including not-yet-due
  overdueCents: moneyTotal,       // the past-due subset — "arrears", in plain words
  depositOutstandingCents: moneyTotal,
  creditCents: moneyTotal,
  nextDueDate: isoDate | null,
  nextDueAmountCents: moneyTotal, // 0 when nextDueDate is null
}
```

Four shape decisions:

- **No signed `balanceCents`.** A tenant reading "−500" has to work out which way the
  minus points. `outstandingCents` and `creditCents` are mutually exclusive and both
  non-negative, so the page says either *"You owe $500"* or *"You are $500 in credit"*
  and never both.
- **`overdueCents` is the word "arrears" avoided.** Same number, less accusatory,
  and it is the number that matters when they are deciding what to transfer today.
- **`nextDueDate` / `nextDueAmountCents`** — the earliest live charge with a remainder
  and a `due_date >= asOfDate`. This is what the tenant actually opened the page for,
  and it costs nothing extra: it is a row the allocation already produced.
- **No `chainId`, no lease list, no landlord-side ids.** Structurally absent.

### 7.3 Chain-wide allocation, lease-scoped reporting

The portal runs **the same chain-wide allocation as the landlord** — the numbers must
match or a tenant disputes a figure the landlord cannot reproduce — but reports only
over the leases the tenant is actually linked to via `lease_tenant`.

- For the common case (one tenant, renewed once or twice) that is the whole chain and
  the two views are identical by construction.
- For a **departed roommate**, it is a prefix. They see their own lease settle when
  the remaining tenant pays, which is correct and reassuring; the alternative — a
  prefix-only allocation — would show them a debt the landlord considers cleared,
  which is the worst possible error on this page.
- **`creditCents` is reported only when the tenant is linked to the chain's latest
  lease; otherwise it is 0.** A credit belongs to whoever is still renting, and
  surfacing a later tenancy's credit to a departed one is an information leak with no
  upside.

The residual: a departed tenant can infer that *someone paid something*, because
their outstanding drops. Accepted. They were jointly liable for that obligation, and
V1 already shows co-tenants each other's payments.

### 7.4 What the tenant does not get

- **No ledger route.** Charges (3a) + payments + balance on one page *is* the
  statement. An interleaved running-balance view is a landlord reconciliation tool.
- **No write of any kind.** No payment claims, no "I paid on the 3rd". V1 §7 settled
  it: a claim queue is a reconciliation workflow and a v2 feature. A tenant never
  writes money and never writes an obligation.
- **No CSV/PDF statement.** Phase 4 or later; named in §12.
- **No totals on the charge list.** 3a withheld them because a total without payments
  changes meaning in 3b; 3b supplies the meaning via `portalBalance`, which is a
  separate call on the same page.

---
## 8. API surface

Conventions unchanged: `/v1`, landlord behind `requireAuth`, tenant under
`/v1/portal/*` behind `requireTenant`, `404` for "absent or not yours" on both
actors. `401` and `500` are not repeated per row.

### 8.1 Landlord — `requireAuth`

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| `POST` | `/v1/leases/:id/payments` | `recordPaymentBody` = `{ kind, method, amountCents, receivedOn, reference?, note? }` | `201 payment` | 404, **409** (lease `draft`/`cancelled`; refund exceeds net received — §4.14), 422 (future `receivedOn`, amount ≤ 0) |
| `GET` | `/v1/leases/:id/payments` | `paymentListQuery` = `pageQuery` + `?from=&to=&kind=&includeVoided=` (default `true`) | `paged(payment)`, ordered `received_on, id` asc | 404, 400 |
| `PATCH` | `/v1/leases/:leaseId/payments/:paymentId` | `updatePaymentNoteBody` = `{ note }` — **the only mutable field** | `payment` | 404, 422 (any other key present — the schema is `.strict()`) |
| `POST` | `/v1/leases/:leaseId/payments/:paymentId/void` | `voidPaymentBody` = `{ reason }` (10..500) | `payment` | 404, 409 (already voided), 422 |
| `POST` | `/v1/leases/:leaseId/payments/:paymentId/correct` | `correctPaymentBody` = `recordPaymentBody` + `{ reason }` | `201 payment` (the successor) | 404, 409 (already voided; refund guard), 422 |
| `GET` | `/v1/leases/:id/ledger` | `?includeVoided=` (default `true`) | `ledgerResponse` | 404, 409 (chain spans two currencies — §6.2) |
| `GET` | `/v1/leases/:id/balance` | — | `leaseBalanceResponse` (chain slice + lease slice) | 404, 409 (same) |
| `GET` | `/v1/arrears` | `arrearsQuery` = `?propertyId=&currency=&minCents=` (default 1) | `arrearsResponse` (grouped by currency) | 400 |

**No `GET /v1/payments`** (portfolio-wide) in 3b. It has no page to live on until the
income report exists, and it is the only thing that would need
`payment_org_received_idx`. Phase 4 adds both together or neither.

`recordPaymentBody` carries **no `currency`** (server copies `lease.currency`) and
**no `chargeId`** (decision 10). Both absences are structural, not validated.

`ledgerResponse`:
```ts
{
  chainId: uuid,
  currency,
  asOfDate: isoDate,                 // localToday(property.timezone)
  leases: [{ id, startDate, endDate, status, rentCents }],  // chain context
  entries: ledgerEntry[],            // ascending by (date, id)
  balance: chainBalance,
  truncated: boolean,                // LEDGER_MAX_ENTRIES = 1000
}
```

`ledgerEntry` is a **discriminated union on `kind`**, not a flattened row with half
its fields null:
- `{ kind: 'charge', ...charge, appliedCents, status, runningBalanceCents }`
- `{ kind: 'payment', ...payment, runningBalanceCents }`

Two orderings live in this response and they are **not** the same thing:
`appliedCents` is **FIFO over charges by `due_date`**; `runningBalanceCents` is
**chronological over the merged stream by effective date** (`due_date` for a charge,
`received_on` for a payment). They answer different questions and will not agree
row-by-row. Say so in the contract comment or someone will "reconcile" them and
break FIFO.

`GET /leases/:id/ledger` renders **the whole chain**, labelled per entry with its
`leaseId`. A chain-allocated `appliedCents` shown over a lease-filtered subset does
not add up, so there is no `?leaseOnly` and there must not be one.

**3a's `GET /v1/leases/:id/charges` is unchanged and stays.** It is what the drift
banner needs (voided rows, generation keys, no allocation). The lease page's money
tab moves to `/ledger`; the drift banner keeps `/charges`. Two routes, two jobs.

### 8.2 Tenant — `requireTenant`

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| `GET` | `/v1/portal/leases/:id/payments` | `pageQuery` + `?from=&to=` | `paged(portalPayment)` | 404 |
| `GET` | `/v1/portal/leases/:id/balance` | — | `portalBalance` | 404 |

That is the entire tenant surface for 3b. Both take a **lease id and nothing else**.

### 8.3 Internal

No change. The cron does not touch payments in 3b; reminders are Phase 4.

---

## 9. The tenant attack walk — new portal routes only

I am an authenticated tenant holding a UUID I should not have.

| Attempt | Result | Why |
|---|---|---|
| `GET /v1/portal/leases/{neighbours_lease}/payments` | `404` | `resolveLease(scope, db, leaseId)` runs **first**. Its filter is `lease.id = $1 AND (lease.org_id, lease_tenant.tenant_id) IN scope.pairs`. Same org, different tenant → zero rows → 404, never 403. Existence is never confirmed. |
| `GET /v1/portal/leases/{other_orgs_lease}/balance` | `404` | Same filter, same zero rows. |
| **Holding a `paymentId` directly** | **n/a — no route accepts one** | Payments are listed by **verified lease id only**. This is the shape decision 3a made for charges, and it is why no payment-id-level guard is needed. If a future phase adds `/v1/portal/payments/:id`, it must re-derive the lease and re-run `resolveLease`. Written here so the omission reads as a decision. |
| `GET /v1/portal/leases/{my_old_lease}/balance` after the chain renewed to someone else | `200`, **my lease's slice only** | §7.3. The allocation spans the chain (so the numbers match the landlord's) but the reported sums are filtered to `lease_tenant`-linked leases, and `creditCents` is zeroed unless I am on the chain's latest lease. The later tenancy's charges are never in the response. |
| `GET /v1/portal/leases/{my_lease}/balance` where a co-tenant paid | `200`, balance reflects it | Intended. Joint liability; V1 §1.4. |
| `POST /v1/leases/{my_lease}/payments` | `403` | Landlord path. `authLayer` falls through to `requireAuth`, which rejects before any query — a tenant has no `member` row. **A tenant never writes money.** |
| `POST /v1/leases/…/payments/…/void` or `/correct`, `PATCH …/payments/…` | `403` | Same. |
| `GET /v1/arrears` | `403` | Same. |
| Tenant creates their own org, then `GET /v1/arrears` | `200 { groups: [], truncated: false }` | `requireAuth` passes for *their own empty org*; every CTE in §3.2 filters `org_id` independently. Zero reach into the landlord's org. |
| `?orgId=` or `?chainId=` on any portal route | ignored | **No route reads an org id or a chain id from a request.** The `chain_id` the ledger partitions on comes out of `resolveLease`'s verified row, so it is as trusted as a session `orgId`. This is the one new id in 3b that could have been a query param and deliberately is not. |
| Forged pagination cursor on `/payments` | `400` | `decodeCursor` validates shape, and the cursor predicate is always ANDed with the scope filter. |
| Tenant archived mid-session, then any portal payment route | `403` | `requireTenant` re-resolves scope from the database on every request; `resolveScope` excludes archived and soft-deleted rows and is never cached. |

**The verify-then-scope shape, to be copied rather than reinvented:**

```ts
// routes/portal-payments.ts
const resolved = await portalLeaseRepo.resolveLease(scope, db, leaseId); // (org, tenant) pair filter
if (!resolved) throw notFound('Lease');
const rows = await paymentRepo.listPayments(resolved.orgId, db, leaseId, query); // ordinary repo fn
```

`listPayments` and `chainBalance` therefore stay in the **landlord** repos with the
ordinary `(orgId, db, …)` signature and the existing `tenancy.guard.test.ts` covers
them. **One new file under `repo/portal/` is needed**, and only one:
`repo/portal/balance.ts`, holding the `lease_tenant`-linked-lease filter from §7.3 —
it takes a `TenantScope` first, so `portal-tenancy.guard.test.ts` covers it by its
existing rule. Everything else reuses `resolveLease`.

**Landlord-vs-landlord, for completeness.** *"I am landlord B holding landlord A's
payment UUID."* `POST /v1/leases/{A_lease}/payments/{A_payment}/void` → the lease
resolve filters `org_id = B` → no row → `404` before the payment id is read. Both
path ids are scoped; neither alone is sufficient. And *"I hold landlord A's
`chain_id`"* → there is no route that accepts one.

---
## 10. Contract additions, file by file

**`billing.ts` does not change. At all.** Same rule as 3a: if 3b needs a change
there, 3b is wrong. The frozen-fixture CI check stays on.

### New: `packages/contract/src/payment.ts`

- `paymentKind`, `paymentMethod`, `paymentMethodLabels`
- `paymentAmountCents` — `money` refined to `> 0` (§2.4)
- `payment` — the landlord response shape
- `recordPaymentBody`, `correctPaymentBody`, `voidPaymentBody`,
  `updatePaymentNoteBody` (`.strict()`, so a stray `amountCents` is a 422 rather than
  a silent no-op)
- `paymentListQuery` — `pageQuery` + `from`/`to`/`kind`/`includeVoided`, reusing
  `queryBoolean` from `charge.ts` (**not** `z.coerce.boolean()` — that bug is already
  documented there)

### New: `packages/contract/src/ledger.ts`

- `chargeStatus`, `chargeStatusLabels`, `chargeStatusFor(...)` (§3.5)
- `allocatedCharge` = `charge.extend({ appliedCents: moneyTotal, status: chargeStatus })`
- `ledgerEntry` — the discriminated union; `ledgerResponse`
- `chainBalance`, `leaseBalanceSlice`, `leaseBalanceResponse`
- `splitBalance(balanceCents) → { owedCents, creditCents }`
- `arrearsQuery`, `arrearsRow`, `arrearsGroup`, `arrearsResponse`
- `ARREARS_MAX_ROWS = 500`, `LEDGER_MAX_ENTRIES = 1000`
- `allocateFifo(...)` — the reference implementation (§3.6), with the comment saying
  in as many words that the server does not call it

### New: `packages/contract/src/ledger.fixtures.ts`

`allocationFixtures` — worked cases, each `{ name, charges, payments, expected }`.
**This is the file that keeps the SQL and the spec from drifting**: the API's
integration test asserts §3.2's output against it over real rows, the contract's unit
test asserts `allocateFifo` against it, and the web asserts its preview against it.
Minimum set, one per §4 row plus the three traps:

exact payment · partial · overpayment-to-credit · payment-before-charge · refund ·
voided payment · voided charge mid-sequence · correction chain ·
**deposit and rent sharing one due date** (the `ROWS`-vs-`RANGE` trap) ·
**chain spanning two leases** · **zero-amount charge** (the `>=` trap) ·
refund exceeding charges · empty lease.

### Edited (additive only)

- `portal.ts` — `+ portalPayment`, `+ portalBalance`. They go here, not in
  `payment.ts`, because `portal.ts`'s module comment is where a reviewer looks to
  answer "what does a tenant see" and the whole answer should be in one file.
- `routes.ts` — `+ leases.payments`, `leases.payment`, `leases.voidPayment`,
  `leases.correctPayment`, `leases.ledger`, `leases.balance`; `+ arrears.list`;
  `+ portal.leasePayments`, `portal.leaseBalance`.
- `index.ts` — export the two new files and the fixtures.

### Confirmed no change needed

- `common.ts` — `moneyDelta` and `moneyTotal` already shipped and 3b is the first
  consumer of both. `money` stays non-negative.
- `charge.ts` — unchanged. `allocatedCharge` **extends** `charge`; the frozen shape is
  not edited, and `queryBoolean` is imported rather than duplicated.
- `lease.ts` — unchanged. The balance is a separate call, not a field on
  `LeaseSummary`; adding it would make the list page's response shape depend on the
  ledger and would re-run the allocation per row.

---

## 11. Task split

Both agents run in parallel against the frozen contract. **The only shared surface is
`packages/contract/**`**, written and frozen by the orchestrator before either is
dispatched. Neither agent edits it; if it is wrong, stop and report upward.

### The paragraph that goes verbatim in both task files

> *Allocation is derived, never stored. There is exactly one definition of which
> money settles which charge — the window function in `apps/api/src/db/repo/ledger.ts`
> — and exactly one reference implementation of the same rule,
> `allocateFifo` in `packages/contract/src/ledger.ts`, which the server never calls
> and which exists only as the test oracle and the browser's optimistic preview. If
> they ever disagree, the SQL is right and the preview is stale, never the other way
> round. A payment, once recorded, is never updated except for `note` and never
> deleted; the only state transition is the void tombstone, and a correction is a
> superseding row. Money is integer cents everywhere, and a balance is `moneyDelta`,
> never `money`.*

### backend-dev — `apps/api/**`

1. **Migration**: `payment_kind` / `payment_method` enums, the `payment` table, the
   `payment_amount_ck` CHECK, `payment_lease_received_idx`. One
   `pnpm --filter api db:generate`. Additive, no backfill.
2. `lib/db-errors.ts` — add the **`23514` → 422** branch (§2.4).
3. `db/repo/payment.ts` — `listPayments`, `resolvePayment`, `recordPayment`,
   `updatePaymentNote`, `voidPayment`, `correctPayment`. All `orgId`-first. Void
   before insert in `correctPayment`; `WHERE voided_at IS NULL` on every void UPDATE,
   so "already voided" is authoritative against a concurrent double-void.
4. `db/repo/ledger.ts` — **the one window query** (§3.2), parameterised by scope, plus
   `leaseLedger`, `chainBalance`, `leaseBalance`, `orgArrears` built on it. Casts
   `::bigint` on every aggregate; `Number()` in the mapper; the
   `COUNT(DISTINCT currency) = 1` assertion.
5. `db/repo/portal/balance.ts` — the `lease_tenant`-linked-lease filter (§7.3).
   `TenantScope` first.
6. Routes: `routes/payments.ts` (five landlord routes), `routes/ledger.ts`
   (`/ledger`, `/balance`, `/v1/arrears`), `routes/portal-payments.ts` (two, mounted
   **before** `portal` — the same `/v1/portal/:tenantId` routing footgun
   `portal-charges.ts` already documents).
7. `lib/mappers.ts` — `mapPayment`, `mapPortalPayment`, `mapLedgerEntry`,
   `mapArrearsRow`.
8. **Two changes to existing lease rules**: `hardDeleteLease` gains the zero-payment
   precondition (§4.13); `renewLease` rejects a currency change with 409 (§6.2).
9. Tests:
   - **`allocation.integration.test.ts`** — the one that matters. Every
     `allocationFixtures` case inserted as real rows, SQL output compared field by
     field to `allocateFifo`.
   - The `ROWS` frame: deposit + rent on one `due_date`, assert each is applied once.
     Then flip the SQL to `RANGE` locally and confirm the test fails — a frame bug
     that no test can catch is a frame bug waiting to ship.
   - `typeof appliedCents === 'number'` and `typeof balanceCents === 'number'` —
     the numeric-as-string guard.
   - The identity `balanceCents === outstandingCents - creditCents`, over every fixture.
   - Chain allocation across a renewal; a payment on lease B clearing lease A.
   - Arrears excludes not-yet-due; arrears excludes deposits; a zero-amount charge
     never appears in arrears.
   - The deposit-return recipe (§4.9) nets to zero and does not reopen prior rent.
   - Refund guard (409) and the future-`receivedOn` 422.
   - Cross-org isolation for every new repo function; the §9 attack table as route
     tests.
10. **Does not touch** `apps/web/**` or `packages/contract/**`.

### frontend-dev — `apps/web/**`

1. `features/payments/` — **Record payment** dialog: amount, date (defaulting to
   `localToday(propertyTimezone)`, with a future date blocked client-side), method,
   reference, note; plus the §3.6 optimistic preview — *"this clears March and $200
   of April"* — from `allocateFifo` over data already on the page.
2. The duplicate-payment confirm step (§4.15), from the payments already loaded.
3. Void and correct dialogs with a mandatory 10–500 character reason, reusing the
   rent-step correction dialog's validation. **The dialog copy carries §4.7's rule
   verbatim**: void = it never happened; refund = it happened and I sent money back.
4. The lease page's money tab moves from `/charges` to **`/ledger`**: interleaved,
   ascending, running balance, per-charge status pill, voids struck through and linked
   to their successor, each row labelled with its lease when the chain has more than
   one. The drift banner keeps reading `/charges`.
5. **Balance chip** on the lease header, and on the tenant and unit cards: signed via
   `splitBalance`, with the **credit** state worded *"Credit $X"* and never *"−$X"*.
6. **Return deposit** action on the move-out flow — one button performing §4.9's
   void + refund (+ optional damage charge), with the resulting net shown before
   committing.
7. `/arrears` — grouped by currency, never summed across; columns: tenant, unit,
   arrears, oldest overdue date, days late; `minCents` and property filters.
8. `/portal/leases/:id` gains the payment history and the balance headline: *"You owe
   $X"* or *"You are $X in credit"*, `nextDueDate` as the sub-line. No signed number,
   no ledger.
9. Loading, empty and error states for all of the above. **Empty is a real state
   here**: a brand-new lease has charges and no payments, and the arrears page is
   *supposed* to be empty most days — "No one is behind" is a feature, not a blank.
10. **Does not touch** `apps/api/**` or `packages/contract/**`.

### They share

`packages/contract/src/payment.ts`, `ledger.ts`, `ledger.fixtures.ts`, the
`portalPayment` / `portalBalance` additions to `portal.ts`, and `routes.ts`.
**Nothing else. No file is touched by both agents.** The one semantic they share
beyond types is `allocationFixtures`: the backend asserts SQL against it, the
frontend asserts its preview against it, and neither needs to know the other exists.

---
## 12. What 3b leaves for later

### Deferred, with a named home

| Deferred | Where it goes |
|---|---|
| All reminders — upcoming, overdue, receipts | Phase 4. `job_run.stats` is already `jsonb`; the overdue scan's "still owes something" predicate is §3.2's query, unchanged. |
| `charge_due_idx on (due_date) where voided_at is null` | Phase 4, with the scan that needs it. |
| `GET /v1/payments` (portfolio-wide) and `payment_org_received_idx` | Phase 4, together or neither. |
| `/v1/exports/payments.csv`, income reports, a tenant statement PDF | Reports phase. The CSV's 10,000-row 409 from V1 §3.5 still stands when it lands. |
| Late fees | **Never automatic** (V1 §7.2 — jurisdictional, a legal exposure rather than a feature). A manual `late_fee` charge already works today. |
| Tenant payment claims ("I paid on the 3rd") | v2. A claim queue is a reconciliation workflow. V1 §7 settled it. |
| Bank feed import, card processing, payment links | Out of scope by the free-tier constraint, not by sequencing. |
| A materialised per-chain balance | Only if the arrears query ever measures slow (§6.3). **Not a cache.** |

### Rejected, not deferred

- **Earmarking a payment to a charge.** Decision 10. The moment it exists, FIFO stops
  being the single source of truth and the product owes the user a reconciliation
  screen forever.
- **A stored allocation table.** Same reason, worse: it can drift from the charges it
  describes, and nothing can detect that it has.
- **A `paid` / `balance` column on `charge` or `lease`.** Every write path would have
  to maintain it, and the one that forgets is silent.
- **A cross-currency total, anywhere.** §6.2.

---

## 13. Risks, assumptions, and where I want input

### Risks I am confident about

| Risk | Mitigation |
|---|---|
| **The default window frame.** `RANGE` groups peers, so a deposit and a first rent sharing one `due_date` are both paid by one payment — a double-apply on the first lease anyone tests. | `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`, written explicitly, with a fixture that fails under `RANGE` (§3.3 #2). |
| **`SUM(bigint)` returns `numeric`**, which the Neon HTTP driver returns as a string. `applied_cents` becomes `"1000"`, arithmetic becomes `NaN`, and nothing in the type system notices. | `::bigint` in SQL, `Number()` in the mapper, `typeof === 'number'` in a test (§3.3 #4). |
| **`money` used for a balance** — every credit fails response validation in `lib/api.ts`. V1 called this the most likely day-one Phase 3 bug. | `moneyDelta` for signed, `moneyTotal` for aggregates; both already in `common.ts`. The contract makes it unrepresentable. |
| **A bare deposit refund reopening prior rent** — arithmetically right, catastrophically wrong on screen. | The void-plus-refund recipe (§4.9), shipped as one UI action rather than left as a thing a landlord must know. |
| **A CHECK violation surfacing as a 500**, exactly as 3a predicted for `23514`. | `payment_amount_ck` is unreachable through the contract, and `db-errors.ts` gains the 23514 → 422 branch anyway. |
| **A chain spanning two currencies** silently summing. | 409 at `renewLease`, plus a `COUNT(DISTINCT currency)` assertion in the repo that throws rather than sums. |
| **A zero-rent lease in permanent arrears** because the status check used `===` not `>=`. | §3.5 rule 2, with a fixture. |
| **Two screens disagreeing** because the balance is computed in SQL for the list and in TS for the detail. | One builder in `repo/ledger.ts`, three callers; the only TS implementation is the contract's oracle, which the server never calls. |
| **A tenant reading a later tenancy's credit** through a chain-wide portal balance. | §7.3's zeroing rule, in the §9 attack table as a route test. |

### Assumptions I made

1. **A chain means one tenancy.** Chain-wide FIFO is correct only under this. It is
   convention today; §13's input request below is how it becomes structure.
2. **A landlord is one person at a time.** The refund guard (§4.14) and the duplicate
   confirm (§4.15) are read-then-write and not race-safe. Both fail safe:
   `GREATEST(0, …)` clamps the allocation regardless.
3. **Tens of landlords, hundreds of leases, tens of charges per chain.** Every "no
   pagination", "no index", "the sort is free" above rests on it. At 10,000 leases the
   arrears query wants a per-chain materialisation; nothing else changes.
4. **Postgres resolves IANA names in `now() at time zone $tz`** exactly as `Intl`
   does in JS. Already relied on by `overdueOnly` in `listChargesForOrgQuery`, and
   `common.ts`'s `timezone` refuses bare offsets precisely to keep the two agreeing.
5. **`date` columns round-trip as `YYYY-MM-DD` strings** through the Neon driver, as
   `charge.dueDate` already does.

### Where I want input — with the default I would ship

| Question | **Default** |
|---|---|
| **Chain-wide vs lease-wide FIFO.** This is the one decision with a real product consequence, and it is worth a sentence from the user. Chain-wide means a payment made today can clear a debt from a lease that ended last year. | **Chain-wide.** Lease-wide produces a phantom debt and a phantom credit on every mid-tenancy rent change, and the sum of two wrong numbers being right is not a defence. |
| **Should `renew` require a tenant in common with its predecessor (409 otherwise)?** It is a Phase-2 behaviour change and would reject an existing workflow where a landlord "renews" into a brand-new tenant. | **Yes, require it.** It is what makes `chain_id` mean "one tenancy" by construction rather than by hope, and chain-wide FIFO depends on that meaning. A new tenant should be a new lease. If the user has shipped the other workflow to someone, say so and I will fall back to a soft warning plus a lease-wide arrears row. |
| **Does the tenant portal show a *credit*, or only "you owe $0"?** Showing it invites "send it back". | **Show it.** Hiding money a tenant has handed over is the fastest way to lose their trust, and the alternative is a balance that does not move when they overpay. |
| **Should `GET /v1/leases/:id/balance` be folded into `GET /v1/leases/:id`?** One fewer round trip on the lease page. | **No, keep it separate.** The lease detail shape is frozen Phase 2; adding a balance makes every lease read run the allocation, including the list page, which would re-run it per row. |
| **`includeVoided` default on the ledger and the payment list.** | **`true`**, matching 3a's charge list for the same reason: a ledger with silently hidden rows is how an hour disappears reconciling a total. The UI strikes them through; it does not drop them. |
