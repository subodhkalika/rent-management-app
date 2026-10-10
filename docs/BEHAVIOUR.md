# What the app does

**This file describes what the system does today, in the present tense.** The
`PLAN-*.md` files describe what was *decided*, and why — they are design records and
they are not always current. When the two disagree, this file is right.

Updated at the end of each phase. Last updated: 2026-10-10, after phase 3b.

---

## Who uses it

Two kinds of people sign in, and they are different kinds of account.

**Landlords** belong to an **organization**. All their data — properties, tenants,
leases, charges — belongs to that organization and no other organization can see any
of it.

**Tenants** are not members of any organization. A tenant record is a person the
landlord manages; a tenant *login* is optional and is created only when the landlord
sends an invite. One person can be a tenant of several landlords with a single login,
and no landlord learns about the others.

A person can be both. Someone who rents out a flat and also rents one elsewhere has a
landlord side and a tenant side, and switches between them in the app.

> **Why tenants are not just restricted members:** every landlord route authorises on
> "do you belong to this organization". A tenant holding that membership would reach
> every route already written and every route written later unless somebody remembered
> a check. The boundary defaults to open, which is the wrong way round.

---

## Properties and units

A **property** is an address. A **unit** is the thing that gets rented — a flat, a
room, a shop. A single-family house is a property with one unit.

Each property has a **timezone** and a **calendar** (Gregorian or Bikram Sambat).
Both matter for money:

- The timezone decides when "today" is, which decides when rent becomes overdue. A
  Perth property evaluates at Perth midnight, not UTC.
- The calendar decides what a "month" is. On Bikram Sambat a period might run 18
  October to 16 November, and rent is prorated against that month's actual length.

Deleting a property or unit is a soft delete and is refused while a lease is active.

---

## Tenants and the portal

A tenant record holds the person's details and is independent of whether they can log
in. `notes` on a tenant is private to the landlord and appears in nothing the tenant
can see.

**Giving a tenant portal access:**

1. The landlord clicks Invite. The tenant must have an email on file.
2. A single-use link is emailed to that address, valid 14 days. The landlord sees the
   link once, to copy if the email bounces — it is never retrievable again.
3. The tenant opens it, sets a password, and is bound to that tenant record.

The account is created with the address **on the invite**, never one typed by whoever
opens the link. Every failure — wrong, expired, revoked, already used, tenant archived
— returns one identical message, so the link cannot be used to discover whether a
tenant exists.

Editing a tenant's email revokes any outstanding invite, because the old link would
otherwise still be live at the old address.

**Revoking access** unbinds the login and kills outstanding invites in one action.

---

## Leases

A lease records who lives in which unit, on what terms. Several tenants can share one
lease and are jointly liable; one of them is primary.

### Lifecycle

```
draft ──activate──> active ──end──> ended | terminated
  │                   │
  └──cancel──>        └──renew──> a new lease in the same chain
   cancelled
```

A lease starts as **draft**, and a draft bills nobody. Activation is the moment money
starts existing, so it is a deliberate step rather than a side effect of creating the
lease.

**Activating requires** the unit to exist, not be marked unavailable, and have no other
active lease; and the lease to have at least one tenant with exactly one primary. One
active lease per unit is enforced by the database, not just checked — without it a
double-booked unit would quietly generate two sets of rent.

Activation sets the unit to occupied and **immediately generates the charges that are
due**.

Ending a lease sets its status straight away even when the end date is months off. The
remaining periods still bill, because the schedule's own end date stops generation, not
the status.

**Renewing** creates a new lease in the same *chain*, so a balance carried from the old
one follows the tenancy rather than being orphaned.

A lease can only be deleted while it is draft or cancelled and has no charges. Once
money exists, it can be ended but never erased.

### Rent and escalation

Rent is **monthly or yearly**. Money is stored as whole cents and never as a decimal.

A lease can carry a **rent ladder** — the rent for each future period. A percentage
escalation clause *drafts* that ladder, and the landlord then edits it. The clause is a
proposal, not a rule evaluated at billing time, so what the tenant was shown is what
they get billed.

A step that has not been billed yet can be edited freely. Once a period has been
billed, changing it requires the **correct** path, which records a reason and keeps an
audit row. A period billed once stays billed, so exactly one of the two paths accepts
any given step.

---

## Charges

A charge is a debt document: *this much, for this period, due on this date*.

### When they appear

**A charge is created on the first day of the period it belongs to.** Not before. A
charge for a month that has not started reads as money already owed, and inflates
every total.

A scheduled job runs daily and writes any period that has started and has no charge
yet. It asks *which periods should exist*, never *what is due today* — so running it
twice writes nothing the second time, and missing a day, a week or a month simply
catches up with every period's correct original due date.

**Billing early is a deliberate action.** *Bill next period early* on an active lease
raises exactly the next period's charge — for when a tenant turns up before the month
starts wanting to pay it. One period only.

### What gets charged

- **Rent**, one per period. The first and last periods are **prorated** by actual days
  occupied over actual days in that period, in that property's own calendar.
- **Deposit**, once, due on the lease start date, if the lease has one.
- **Opening balance**, once, for onboarding a tenancy that was already running.
- **Manual charges** — late fees, utilities, anything else — raised by the landlord.

### Changing a charge

**A charge is never edited and never deleted.** The only thing that can happen to one
is being **voided**, which requires a reason.

To fix a wrong amount: void it and raise a correction, which is a new charge linked to
the one it replaces. Both stay visible, the old one struck through.

A voided charge is **never regenerated**. Voiding March's rent is a decision, not a gap
to be refilled tomorrow morning.

### When the lease changes afterwards

Charges already written keep their numbers. Correcting a rent ladder or editing lease
terms changes what *future* periods will be generated as — it never rewrites a charge
that already exists.

Because that is invisible otherwise, the lease shows a **review banner** when written
charges and the current schedule disagree, saying which periods differ and offering to
void and replace them. It stays silent about a period that was deliberately voided,
since there is nothing to act on.

---

---

## Payments and what is owed

The landlord records money as it arrives — bank transfer, cash, cheque, UPI. Nothing
is automated, and there is no card processing.

### How a payment settles charges

Money goes to the **oldest debt first**, by due date. Nothing is earmarked to a
particular charge, and a payment cannot be pointed at one: what is paid is derived
from the charges and the payments, every time it is asked for, so there is nothing
that can drift out of step with the rows it describes.

**Allocation spans the whole tenancy, not one lease.** A tenant who renewed and still
owed from last year has that cleared by their next payment. Where a chain has more
than one lease, the ledger says which lease a row belongs to, and an older charge
settled this way says so — otherwise it reads as money landing in the wrong place.

Everything awkward falls out of that one rule without a special case:

| | |
|---|---|
| Paid part of the rent | The oldest charge takes what there is; the next gets nothing |
| Paid too much | Every charge fills up and the rest is a **credit** |
| Paid before the charge exists | The credit waits, and the charge is born paid |
| Cheque bounced | Void the payment — allocation retreats from the newest charges back |
| Rent changed mid-tenancy | Nothing. One queue across the whole tenancy |

### Correcting money

**A payment is never edited and never deleted**, with one exception: its private
**note**, which no tenant sees. A reference number is evidence and cannot change.

To fix a wrong amount, **correct** it — the original is voided and a replacement is
linked to it, both visible. To record that money never really arrived, **void** it.

> **Void and refund are not the same thing.** Void means *this never happened, or I
> recorded it wrong*. Refund means *it happened and I sent money back*. A bounced
> cheque is a void; returning a deposit is a refund.

**Returning a deposit** is a single action, not a bare refund. A bare refund would
retreat from the newest charges and make last month's rent read unpaid. The action
voids the deposit charge and records the refund together, so it nets to zero and the
ledger tells the story.

### Balances and arrears

A balance is shown as **"Owes X"** or **"Credit of X"** — never as a negative number,
and never on the tenant's side as a sign at all.

The deposit is counted separately from everything else. Chasing a bond is a different
conversation from chasing rent, and an unpaid deposit must not make someone look like
a non-payer.

**Arrears** is what is past due, excluding deposits, judged in the property's own
timezone. Rent that exists but is not due yet is not arrears. The arrears page is
grouped by currency and never adds across them, and a tenancy that has ended still
appears if it owes money — a departed tenant who never paid is exactly who that page
is for.

---

## What is not built yet

- **Reminders** — email before due and after overdue.
- **Maintenance requests** and **document storage**.
- **Reports and CSV export.**

Until payments exist, the app records what is owed and not what has been received, so
no total anywhere claims to be a balance.

---

## Things that commonly surprise people

**A new lease is in draft and bills nothing.** Open it and click Activate.

**Activating a backdated lease creates every period since its ledger start, at once.**
That is correct — the rent was owed — but the activation dialog shows the count and
total first, because several overdue charges appearing in one click is alarming
otherwise.

**On a Bikram Sambat property, period boundaries land on odd Gregorian dates.** A
period running 18 October to 16 November is a BS month, not a mistake. "Billing day 1"
means the first of the BS month.

**Overdue is evaluated in the property's timezone.** A charge due today is not overdue,
wherever the person looking at it happens to be.
