import { z } from 'zod';
import { isoDate, money, type IsoDate } from './common.js';
import {
  calendarSystem,
  calendarForSystem,
  MAX_BILLING_DAY,
  type Calendar,
  type CalendarSystem,
} from './calendar/index.js';
import {
  parseIsoDate,
  toIsoDate,
  addDays,
  compareIsoDate,
  daysBetweenInclusive,
  minIsoDate,
  maxIsoDate,
  clampIsoDate,
  daysFromCivil,
} from './calendar/civil-days.js';
import { isLeapYear, daysInMonth, addMonths, addYears, clampDayToMonth } from './calendar/gregorian.js';

/**
 * PURITY IS THE POINT.
 *
 * Everything in this file is plain integer/string arithmetic on `IsoDate` strings
 * and numbers. No wall-clock read, no bare/zero-argument `Date` construction, no
 * `Intl`, no I/O. Same rule for `./calendar/*`: a table-driven calendar needs it even
 * more than Gregorian does.
 *
 * `IsoDate` strings are fixed-width `YYYY-MM-DD`, so lexicographic comparison is
 * chronological comparison — `compareIsoDate` (from `./calendar/civil-days.js`) never
 * touches a `Date` object. Day-count arithmetic (`addDays`, `daysBetweenInclusive`)
 * uses the Howard Hinnant `days_from_civil` / `civil_from_days` algorithm: pure
 * integer conversion between a proleptic-Gregorian (year, month, day) triple and a
 * day count relative to the 1970-01-01 epoch. No `Date` object is ever constructed.
 *
 * The same logic runs in the browser's live schedule preview and (in Phase 3) the
 * server's cron. If it ever touched the wall clock or the runtime's locale, the two
 * could disagree — which is the one bug this design exists to prevent.
 *
 * CALENDAR SEAM — `./calendar/index.ts` exports the `Calendar` interface and
 * `calendarForSystem`, a resolver from the `calendarSystem` enum ('gregorian' |
 * 'bikram_sambat') to an implementation. `periodsOverlapping`, `periodContaining`,
 * `isPeriodStart` and `dueDateFor` all take a `CalendarSystem` (defaulting to
 * 'gregorian' so existing call sites are unaffected) and resolve it once internally.
 * `addDays`, `compareIsoDate`, `daysBetweenInclusive`, `minIsoDate`, `maxIsoDate` and
 * `clampIsoDate` stay OUTSIDE that interface, imported from `./calendar/civil-days.js`
 * — they operate on the proleptic day number, which is the same regardless of which
 * calendar is choosing period boundaries. `isLeapYear`, `daysInMonth`, `addMonths`,
 * `addYears` and `clampDayToMonth` stay exported from here with identical signatures,
 * now delegating to `./calendar/gregorian.js`. `isLeapYear` has no analogue on
 * `Calendar` — it is Gregorian-specific and is NOT part of the interface.
 */

export { calendarSystem, type CalendarSystem };
export { isLeapYear, daysInMonth, addMonths, addYears, clampDayToMonth };
export { parseIsoDate, toIsoDate, addDays, compareIsoDate, daysBetweenInclusive, minIsoDate, maxIsoDate, clampIsoDate };

/* ======================================================================== */
/* frequency                                                                 */
/* ======================================================================== */

export const rentFrequency = z.enum(['monthly', 'yearly']);
export type RentFrequency = z.infer<typeof rentFrequency>;

export const rentFrequencyLabels: Record<RentFrequency, string> = {
  monthly: 'Monthly',
  yearly: 'Yearly',
};

/* ======================================================================== */
/* move-out billing policy — property-level, read live, applied inside      */
/* buildSchedule only (Amendment A)                                         */
/* ======================================================================== */

export const moveOutBillingPolicy = z.enum(['bill_full_term', 'stop_at_move_out']);
export type MoveOutBillingPolicy = z.infer<typeof moveOutBillingPolicy>;

export const moveOutBillingPolicyLabels: Record<MoveOutBillingPolicy, string> = {
  bill_full_term: 'Bill the full term',
  stop_at_move_out: 'Stop rent at move-out',
};

/* ======================================================================== */
/* periods                                                                   */
/* ======================================================================== */

export const billingPeriod = z.object({
  /** 0-based from the lease's FIRST natural period. Anchored, NOT the array index. */
  index: z.number().int(),
  /** Natural period start, inclusive. NOT clipped to the lease. */
  start: isoDate,
  /** Natural period end, inclusive. */
  end: isoDate,
});
export type BillingPeriod = z.infer<typeof billingPeriod>;

/**
 * Builds the period at a known index relative to `anchorDate`, for either cadence,
 * under `calendar`.
 *
 * Monthly: `calendar.startOfMonth`/`addMonths`/`endOfMonth` do the calendar-specific
 * work; `index` counts calendar months from the one containing `anchorDate`.
 *
 * Yearly: periods anchor on `anchorDate`'s own day, not the start of its month or
 * year — a lease starting mid-month renews on that same day each cycle. `addYears`
 * is the only calendar-specific step; the period boundary one day before the next
 * anniversary is day-number arithmetic (`addDays`), same as before.
 */
function periodAtIndex(f: RentFrequency, calendar: Calendar, anchorDate: IsoDate, index: number): BillingPeriod {
  if (f === 'monthly') {
    const anchorFirst = calendar.startOfMonth(anchorDate);
    const start = calendar.addMonths(anchorFirst, index);
    const end = calendar.endOfMonth(start);
    return { index, start, end };
  }
  const start = calendar.addYears(anchorDate, index);
  const end = addDays(calendar.addYears(anchorDate, index + 1), -1);
  return { index, start, end };
}

/**
 * Finds the period index containing `on`, for either cadence, by estimating from the
 * day-number distance to `anchorDate` and correcting to the exact boundary. Works for
 * ANY `Calendar` without needing to know the calendar's own year/month numbering for
 * an arbitrary `IsoDate` — `Calendar` does not expose that reverse mapping, only
 * `addMonths`/`addYears`/`startOfMonth`/`endOfMonth`, which this builds on via
 * `periodAtIndex`. The correction loop makes the result exact regardless of how
 * rough the initial guess is; for Gregorian, where the old code computed the index in
 * one step via year/month subtraction, this converges in zero or one iteration and
 * returns an identical index — it replaces a special case with a general one, not a
 * different answer.
 */
function periodIndexFor(f: RentFrequency, calendar: Calendar, anchorDate: IsoDate, on: IsoDate): number {
  const anchorBase = f === 'monthly' ? calendar.startOfMonth(anchorDate) : anchorDate;
  const averageDaysPerPeriod = f === 'monthly' ? 30 : 365;
  const signedDays =
    daysFromCivilOf(on) - daysFromCivilOf(anchorBase); // positive when `on` is after the anchor
  let k = Math.trunc(signedDays / averageDaysPerPeriod);
  let period = periodAtIndex(f, calendar, anchorDate, k);
  while (compareIsoDate(on, period.start) < 0) {
    k -= 1;
    period = periodAtIndex(f, calendar, anchorDate, k);
  }
  while (compareIsoDate(on, period.end) > 0) {
    k += 1;
    period = periodAtIndex(f, calendar, anchorDate, k);
  }
  return k;
}

/**
 * Signed day-number distance from the 1970-01-01 epoch, for the estimate in
 * `periodIndexFor`. Reuses the day-number layer rather than re-deriving it:
 * `IsoDate` is always Gregorian on the wire (see `docs/DATES.md`), so this is valid
 * regardless of which `Calendar` is in play — it is only ever used here as an
 * ESTIMATE, corrected to exactness by the while-loops above.
 */
function daysFromCivilOf(d: IsoDate): number {
  const { year, month, day } = parseIsoDate(d);
  return daysFromCivil(year, month, day);
}

export function periodContaining(
  f: RentFrequency,
  anchorDate: IsoDate,
  on: IsoDate,
  system: CalendarSystem = 'gregorian',
): BillingPeriod {
  const calendar = calendarForSystem(system);
  const index = periodIndexFor(f, calendar, anchorDate, on);
  return periodAtIndex(f, calendar, anchorDate, index);
}

/** A contiguous, gapless, non-overlapping cover of every period overlapping `[from, to]`. */
export function periodsOverlapping(
  f: RentFrequency,
  anchorDate: IsoDate,
  from: IsoDate,
  to: IsoDate,
  system: CalendarSystem = 'gregorian',
): BillingPeriod[] {
  if (compareIsoDate(from, to) > 0) return [];
  const calendar = calendarForSystem(system);
  const firstIndex = periodIndexFor(f, calendar, anchorDate, from);
  const lastIndex = periodIndexFor(f, calendar, anchorDate, to);
  const result: BillingPeriod[] = [];
  for (let i = firstIndex; i <= lastIndex; i += 1) {
    result.push(periodAtIndex(f, calendar, anchorDate, i));
  }
  return result;
}

export function isPeriodStart(
  f: RentFrequency,
  anchorDate: IsoDate,
  d: IsoDate,
  system: CalendarSystem = 'gregorian',
): boolean {
  return compareIsoDate(periodContaining(f, anchorDate, d, system).start, d) === 0;
}

/* ======================================================================== */
/* due date — one formula, zero special cases                               */
/* ======================================================================== */

/** The billingDay-th day of the month containing `anyDateInMonth`, under `calendar`,
 *  clamped to that month's actual length. Built only from `startOfMonth`/`endOfMonth`
 *  (interface) plus `addDays`/`daysBetweenInclusive` (day-number layer) — no reverse
 *  year/month mapping needed, unlike the old Gregorian-only `clampDayToMonth` call
 *  this replaces here. */
function dayOfMonthClamped(calendar: Calendar, anyDateInMonth: IsoDate, day: number): IsoDate {
  const start = calendar.startOfMonth(anyDateInMonth);
  const end = calendar.endOfMonth(anyDateInMonth);
  const length = daysBetweenInclusive(start, end);
  const clamped = Math.min(Math.max(day, 1), length);
  return addDays(start, clamped - 1);
}

export function dueDateFor(input: {
  frequency: RentFrequency;
  period: BillingPeriod;
  occupiedStart: IsoDate;
  occupiedEnd: IsoDate;
  /** 1..32; ignored when `frequency === 'yearly'`. Bound by the calendar's own
   *  maximum — see `MAX_BILLING_DAY` / `Calendar.maxDayOfMonth`. */
  billingDay: number;
  /** Defaults to Gregorian so existing call sites are unaffected. */
  calendar?: CalendarSystem;
}): IsoDate {
  const { frequency, period, occupiedStart, occupiedEnd, billingDay, calendar: system = 'gregorian' } = input;
  const calendar = calendarForSystem(system);
  const raw = frequency === 'monthly' ? dayOfMonthClamped(calendar, period.start, billingDay) : period.start;
  return clampIsoDate(raw, occupiedStart, occupiedEnd);
}

/* ======================================================================== */
/* proration                                                                 */
/* ======================================================================== */

export function prorate(rentCents: number, daysOccupied: number, daysInPeriod: number): number {
  return Math.round((rentCents * daysOccupied) / daysInPeriod);
}

/* ======================================================================== */
/* rent escalation — R2: a stored ladder of steps, drafted by a clause       */
/*                                                                            */
/* A lease's rent is no longer a constant, and it is no longer a formula. It */
/* is a list of stored steps. The rent for any period is                     */
/* `rentForPeriodStart(terms, periodStart)` — a pure lookup, fixture-pinned. */
/* The clause below is only a generator: `generateRentSteps` drafts a ladder */
/* the landlord then edits, and the stored steps are the truth from that     */
/* moment on. Multiplying a rent by a percentage anywhere outside            */
/* `generateRentSteps`/`clauseExpectedRent`/`recomputeLadderFrom` — or       */
/* converting a percentage to basis points anywhere but a form's input edge  */
/* — is the second implementation this whole design exists to prevent.      */
/* ======================================================================== */

/**
 * `'clause'` = the generator drafted this and nobody has touched it.
 * `'manual'` = a human set this number — by hand, or by overriding a draft. A step
 * stays `'manual'` until an explicit *reset* hands it back to the clause.
 */
export const rentStepSource = z.enum(['clause', 'manual']);
export type RentStepSource = z.infer<typeof rentStepSource>;

export const rentStep = z.object({
  /** A billing-period start, strictly after the lease's startDate. Already snapped
   *  — the straddle is resolved at generation time (`generateRentSteps`), never at
   *  read time (`rentForPeriodStart`). */
  effectiveFrom: isoDate,
  rentCents: money,
});
export type RentStep = z.infer<typeof rentStep>;

/** `rentStep` plus drafting provenance — what `generateRentSteps` and
 *  `recomputeLadderFrom` return. `clauseExpectedCents` is display-only: "what the
 *  clause would have said", frozen at the moment a step was last clause-drafted,
 *  independent of any later override. */
export const draftRentStep = rentStep.extend({
  source: rentStepSource,
  clauseExpectedCents: z.number().int().nullable(),
});
export type DraftRentStep = z.infer<typeof draftRentStep>;

export const rentEscalationMode = z.enum(['none', 'percent']);
export type RentEscalationMode = z.infer<typeof rentEscalationMode>;
export const rentEscalationModeLabels: Record<RentEscalationMode, string> = {
  none: 'No increase',
  percent: 'Percentage',
};

export const rentEscalationCompounding = z.enum(['compound', 'simple']);
export type RentEscalationCompounding = z.infer<typeof rentEscalationCompounding>;
export const rentEscalationCompoundingLabels: Record<RentEscalationCompounding, string> = {
  compound: 'Compounds on the previous rent',
  simple: 'Always on the original rent',
};

/** Integer basis points — 10% is `1000`, never a float (`7.35 * 100 ===
 *  734.9999999999999`). `BPS_SCALE` and `STEP_PROPOSAL_ROUNDING_UNIT` are the
 *  generator's own constants and must never be referenced outside it (or outside
 *  `packages/contract`) — if you find yourself importing them to multiply a rent,
 *  you are writing a second clause engine. */
export const BPS_SCALE = 10_000;
/** 50% per step — the ceiling that catches a 100%-instead-of-10% typo. */
export const MAX_ESCALATION_RATE_BPS = 5_000;
export const MAX_ESCALATION_INTERVAL_YEARS = 10;
/** A rolling lease has no natural stopping point; this is the generator's ceiling —
 *  30 years at a one-year interval, well beyond any real lease (see "flat past the
 *  last step" in the escalation plan). */
export const MAX_GENERATED_STEPS = 30;
/** One major unit. The generator's opening offer, half-up — never a rule applied at
 *  read time. A landlord who wants the paisa types over the proposal and it is
 *  stored exactly. */
export const STEP_PROPOSAL_ROUNDING_UNIT = 100;

/** `mode: 'none'` is not a value of this schema — it is the ABSENCE of one.
 *  `escalation: RentEscalation | null`, never `{ mode: 'none' }`, so there is
 *  exactly one representation of "no clause". Zero `rateBps` is rejected at the
 *  schema boundary for the same reason: two spellings of "none" is a bug factory. */
export const rentEscalation = z.object({
  mode: z.literal('percent'),
  rateBps: z.number().int().min(1).max(MAX_ESCALATION_RATE_BPS),
  intervalYears: z.number().int().min(1).max(MAX_ESCALATION_INTERVAL_YEARS),
  compounding: rentEscalationCompounding,
});
export type RentEscalation = z.infer<typeof rentEscalation>;

/* ======================================================================== */
/* terms + schedule                                                          */
/* ======================================================================== */

export const leaseBillingTerms = z.object({
  frequency: rentFrequency,
  rentCents: money,
  /** 1..32 — 32 because Bikram Sambat months reach 32 days (see
   *  `./calendar/bs-data.ts`). The true per-calendar ceiling is narrower
   *  (`Calendar.maxDayOfMonth` / `MAX_BILLING_DAY`); `validateBillingTerms` enforces
   *  it. This bound is only the outer structural limit shared by every calendar. */
  billingDay: z.number().int().min(1).max(32),
  startDate: isoDate,
  endDate: isoDate.nullable(),
  ledgerStartDate: isoDate,
  /** Raw move-out date. Never pre-applied — `effectiveBillingEnd` is the only interpreter. */
  moveOutDate: isoDate.nullable(),
  /** Resolved live from the property. */
  moveOutBillingPolicy,
  /** Which calendar defines this lease's periods. Storage and every `IsoDate` value
   *  here stay Gregorian regardless — see `docs/DATES.md`. */
  calendar: calendarSystem,
  /** Ascending by effectiveFrom, no duplicates, all > startDate, all period starts.
   *  EMPTY = a constant rent for the whole term (the pre-escalation, byte-identical
   *  case). The clause that may have drafted these is deliberately NOT part of this
   *  object — see the section header above. */
  rentSteps: z.array(rentStep).default([]),
});
export type LeaseBillingTerms = z.infer<typeof leaseBillingTerms>;

export const plannedCharge = z.object({
  generationKey: isoDate,
  periodIndex: z.number().int(),
  periodStart: isoDate,
  periodEnd: isoDate,
  occupiedStart: isoDate,
  occupiedEnd: isoDate,
  daysOccupied: z.number().int().nonnegative(),
  daysInPeriod: z.number().int().positive(),
  dueDate: isoDate,
  amountCents: z.number().int().nonnegative(),
  isProrated: z.boolean(),
});
export type PlannedCharge = z.infer<typeof plannedCharge>;

/**
 * The last day this lease bills for. The ONLY place the move-out policy is
 * interpreted. Exported so it is independently testable and nameable — NOT so
 * callers can call it before `buildSchedule`. `buildSchedule` calls it internally;
 * callers pass raw terms via `billingTermsFor` (in `lease.ts`).
 *
 * Can only ever SHORTEN `endDate`, never extend it (I13).
 */
export function effectiveBillingEnd(terms: LeaseBillingTerms): IsoDate | null {
  if (terms.moveOutBillingPolicy === 'bill_full_term') return terms.endDate;
  if (terms.moveOutDate === null) return terms.endDate;
  if (terms.endDate === null) return terms.moveOutDate;
  return minIsoDate(terms.moveOutDate, terms.endDate);
}

/**
 * The rent in force at `periodStart` — a PURE LOOKUP over sorted `terms.rentSteps`
 * (I20 guarantees ascending order). No multiplication, no rounding, no calendar
 * call — a stepped rent is stored data, not a recurrence to re-derive. With
 * `rentSteps: []` this is the byte-identical pre-escalation case: the early return
 * on line one is exactly that guarantee.
 *
 * Beyond the last step the rent is flat — this function never extrapolates.
 */
export function rentForPeriodStart(terms: LeaseBillingTerms, periodStart: IsoDate): number {
  if (terms.rentSteps.length === 0) return terms.rentCents;
  let rent = terms.rentCents;
  for (const s of terms.rentSteps) {
    if (compareIsoDate(s.effectiveFrom, periodStart) > 0) break;
    rent = s.rentCents;
  }
  return rent;
}

export const MAX_SCHEDULE_PERIODS = 600;
/**
 * How far ahead the scheduled run writes charges: not at all.
 *
 * A period's charge is created on that period's first day, never before. A charge is
 * a debt document, and one that exists for a month which has not started reads as
 * money already owed — it inflates every total and makes an activation preview look
 * alarming for no reason.
 *
 * Billing further ahead is a deliberate act, not a default: see
 * `chargesThroughNextPeriod`, which the landlord triggers when a tenant wants to pay
 * early.
 *
 * Kept as a named constant rather than inlined because the value is a decision, and
 * Phase 4 is expected to make it configurable per organisation.
 */
export const GENERATION_LOOKAHEAD_DAYS = 0;
export const DEPOSIT_GENERATION_KEY = 'deposit';
export const OPENING_BALANCE_GENERATION_KEY = 'opening';

/**
 * Rent charges only. The deposit and the opening balance are single non-periodic
 * charges Phase 3 writes once, keyed `DEPOSIT_GENERATION_KEY` (due `startDate`) and
 * `OPENING_BALANCE_GENERATION_KEY` (due `ledgerStartDate`). A period key is always
 * `YYYY-MM-DD`, so no collision is possible.
 *
 * `through` filters on `periodStart <= through` — the only coherent reading for a
 * cron. Throws `RangeError` past `MAX_SCHEDULE_PERIODS`.
 */
export function buildSchedule(terms: LeaseBillingTerms, through: IsoDate): PlannedCharge[] {
  const windowStart = maxIsoDate(terms.startDate, terms.ledgerStartDate);
  const billingEnd = effectiveBillingEnd(terms);
  const to = billingEnd === null ? through : minIsoDate(billingEnd, through);

  if (compareIsoDate(windowStart, to) > 0) return [];

  const periods = periodsOverlapping(terms.frequency, terms.startDate, windowStart, to, terms.calendar);
  if (periods.length > MAX_SCHEDULE_PERIODS) {
    throw new RangeError(
      `Schedule would produce ${periods.length} periods, exceeding MAX_SCHEDULE_PERIODS (${MAX_SCHEDULE_PERIODS})`,
    );
  }

  const result: PlannedCharge[] = [];
  for (const p of periods) {
    if (compareIsoDate(p.start, through) > 0) break;

    const occupiedStart = maxIsoDate(p.start, windowStart);
    const occupiedEnd = billingEnd === null ? p.end : minIsoDate(p.end, billingEnd);
    if (compareIsoDate(occupiedEnd, occupiedStart) < 0) continue;

    const daysInPeriod = daysBetweenInclusive(p.start, p.end);
    const daysOccupied = daysBetweenInclusive(occupiedStart, occupiedEnd);
    const periodRent = rentForPeriodStart(terms, p.start);
    const amountCents = daysOccupied === daysInPeriod ? periodRent : prorate(periodRent, daysOccupied, daysInPeriod);

    result.push({
      generationKey: p.start,
      periodIndex: p.index,
      periodStart: p.start,
      periodEnd: p.end,
      occupiedStart,
      occupiedEnd,
      daysOccupied,
      daysInPeriod,
      dueDate: dueDateFor({
        frequency: terms.frequency,
        period: p,
        occupiedStart,
        occupiedEnd,
        billingDay: terms.billingDay,
        calendar: terms.calendar,
      }),
      amountCents,
      isProrated: daysOccupied < daysInPeriod,
    });
  }
  return result;
}

/* ======================================================================== */
/* the generator — drafts the ladder, never reads it back (R2)              */
/* ======================================================================== */

/**
 * The generator's ONE arithmetic primitive — a PROPOSAL, never applied at read time.
 * Rounds to the nearest `STEP_PROPOSAL_ROUNDING_UNIT`, half-up (`Math.round` on
 * exact `.5` rounds away from zero for positive numbers, which is what "half-up"
 * means for money).
 */
function proposeOnce(cents: number, rateBps: number): number {
  const raw = (cents * (BPS_SCALE + rateBps)) / BPS_SCALE;
  return Math.round(raw / STEP_PROPOSAL_ROUNDING_UNIT) * STEP_PROPOSAL_ROUNDING_UNIT;
}

/**
 * `simple`'s own formula, generalized over WHICH figure it is simple about:
 * `anchorCents * (1 + cycle * rate)`, rounded once. `clauseExpectedRent` calls this
 * with `anchorCents = baseRentCents` (cycle counted from the lease's original base).
 * `recomputeLadderFrom` calls it with `anchorCents` = an override (cycle counted from
 * THAT override) — see the re-anchoring note on `recomputeLadderFrom`.
 */
function proposeSimple(anchorCents: number, rateBps: number, cycle: number): number {
  const raw = (anchorCents * (BPS_SCALE + cycle * rateBps)) / BPS_SCALE;
  return Math.round(raw / STEP_PROPOSAL_ROUNDING_UNIT) * STEP_PROPOSAL_ROUNDING_UNIT;
}

/**
 * What the clause ALONE would say at `cycle` (1-based: the first increase is cycle
 * 1), counted from the lease's original base. Display only — drives
 * `clauseExpectedCents` and the "agreed X" line. Never called at schedule-read time.
 *
 * `compound` folds `proposeOnce` from the previous cycle's proposal; `simple`
 * applies the rate to `baseRentCents` `cycle` times over, rounding once.
 */
export function clauseExpectedRent(clause: RentEscalation, baseRentCents: number, cycle: number): number {
  if (clause.compounding === 'simple') {
    return proposeSimple(baseRentCents, clause.rateBps, cycle);
  }
  let rent = baseRentCents;
  for (let i = 0; i < cycle; i += 1) {
    rent = proposeOnce(rent, clause.rateBps);
  }
  return rent;
}

/**
 * The first billing-period start on or after `d` — the straddle resolution the
 * escalation plan assigns to generation time, never to read time. Periods are a
 * contiguous, gapless cover (`periodsOverlapping`'s own guarantee), so the start of
 * the period immediately after the one containing `d` is exactly one day past that
 * period's end — no second calendar call is needed to find it.
 */
function firstPeriodStartOnOrAfter(
  frequency: RentFrequency,
  anchorDate: IsoDate,
  d: IsoDate,
  system: CalendarSystem,
): IsoDate {
  const containing = periodContaining(frequency, anchorDate, d, system);
  if (compareIsoDate(containing.start, d) === 0) return d;
  return addDays(containing.end, 1);
}

/**
 * Drafts the ladder a landlord previews before saving. Snaps each `effectiveFrom`
 * to a period start (§3.5 of the escalation plan) and stops at the earlier of
 * `endDate` and `MAX_GENERATED_STEPS` cycles. Deterministic and total: never throws
 * for any in-range lease — a BS anniversary that falls outside the supported BS
 * range (`BsDateOutOfRangeError`, a `RangeError`) simply ends the ladder early,
 * because a lease's own window is already bounded by `validateEndDateSchedulable`.
 *
 * The ONLY place the clause's rate/interval arithmetic runs. `rentForPeriodStart`
 * never calls this — it only ever reads the steps this produced (or that a landlord
 * typed over).
 */
export function generateRentSteps(input: {
  clause: RentEscalation;
  baseRentCents: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  frequency: RentFrequency;
  calendar: CalendarSystem;
}): DraftRentStep[] {
  const { clause, baseRentCents, startDate, endDate, frequency, calendar: system } = input;
  const calendar = calendarForSystem(system);
  const steps: DraftRentStep[] = [];

  for (let cycle = 1; cycle <= MAX_GENERATED_STEPS; cycle += 1) {
    let rawAnniversary: IsoDate;
    try {
      rawAnniversary = calendar.addYears(startDate, cycle * clause.intervalYears);
    } catch (e) {
      if (e instanceof RangeError) break;
      throw e;
    }
    if (endDate !== null && compareIsoDate(rawAnniversary, endDate) > 0) break;

    let effectiveFrom: IsoDate;
    try {
      effectiveFrom = firstPeriodStartOnOrAfter(frequency, startDate, rawAnniversary, system);
    } catch (e) {
      if (e instanceof RangeError) break;
      throw e;
    }
    if (endDate !== null && compareIsoDate(effectiveFrom, endDate) > 0) break;

    const rentCents = clauseExpectedRent(clause, baseRentCents, cycle);
    steps.push({ effectiveFrom, rentCents, source: 'clause', clauseExpectedCents: rentCents });
  }

  return steps;
}

/**
 * Re-drafts the ladder after a landlord overrides `steps[index]` to `newRentCents`.
 * Decision 5 of the escalation plan, in full:
 *
 * - The overridden step becomes `source: 'manual'`. Its `clauseExpectedCents` is
 *   left exactly as it was — that field is "what was agreed", frozen at whatever it
 *   held before, which is what lets the UI show "agreed X, you set Y".
 * - Every LATER `'clause'` step is recomputed. The override RE-ANCHORS the ladder:
 *   it becomes the new base for every later `'clause'` step, and the clause
 *   continues IN ITS OWN MODE from there. `clauseExpectedCents` is updated to match,
 *   because a step still driven by the clause has nothing else to show: what it
 *   says IS what was agreed, now.
 * - Every LATER `'manual'` step is preserved verbatim, full stop — a figure a
 *   landlord set by hand is a decision, not a draft, and the cascade must never
 *   move underneath them. It still counts as one elapsed cycle for `simple`'s
 *   counter below, because a cycle is a unit of time elapsed under the clause, not a
 *   property of who set the figure.
 *
 * `compound` folds `proposeOnce` forward from the immediately preceding rent in the
 * (possibly already-edited) ladder — unchanged by this re-anchoring, because that is
 * already what re-anchoring means for a formula with no separate "base" to begin
 * with.
 *
 * `simple` is where re-anchoring is the whole story: a clause reading "10% simple"
 * describes a KIND of increase, not a number, and an override changes the amount,
 * not the kind. So every later `'clause'` step is `newRentCents * (1 + j * rate)`
 * for `j` = 1, 2, 3 … counted from the override's OWN position in the ladder (`j`
 * advances for every step after the override, manual or clause, since it is
 * counting elapsed cycles, not counting how many of them got recomputed) — never
 * folded onto the previous step's value, and never counted from the lease's
 * original base, which an override has already superseded. Switching a `simple`
 * clause to compounding after one override would silently change the character of
 * the agreement the landlord signed; re-anchoring is what keeps it "10% simple"
 * before and after.
 *
 * Deliberately takes no `baseRentCents`: recomputation never needs the lease's
 * original base — a `compound` cascade only ever needs the immediately preceding
 * rent, and a `simple` cascade's anchor IS the override itself. `clause: null` (the
 * commercial, hand-entered case) recomputes nothing but the touched index — there is
 * no clause to carry forward.
 */
export function recomputeLadderFrom(input: {
  clause: RentEscalation | null;
  steps: readonly DraftRentStep[];
  index: number;
  newRentCents: number;
}): DraftRentStep[] {
  const { clause, steps, index, newRentCents } = input;
  const result: DraftRentStep[] = steps.map((s) => ({ ...s }));
  const target = result[index];
  if (target === undefined) {
    throw new RangeError(`recomputeLadderFrom: index ${index} is out of range for a ladder of ${result.length}`);
  }
  result[index] = { ...target, rentCents: newRentCents, source: 'manual' };

  let previous = newRentCents;
  let cyclesSinceOverride = 0;
  for (let i = index + 1; i < result.length; i += 1) {
    const step = result[i];
    if (step === undefined) continue;
    cyclesSinceOverride += 1;
    if (clause === null || step.source !== 'clause') {
      previous = step.rentCents;
      continue;
    }
    const recomputed =
      clause.compounding === 'simple'
        ? proposeSimple(newRentCents, clause.rateBps, cyclesSinceOverride)
        : proposeOnce(previous, clause.rateBps);
    result[i] = { ...step, rentCents: recomputed, clauseExpectedCents: recomputed };
    previous = recomputed;
  }

  return result;
}

/* ======================================================================== */
/* generation                                                                */
/* ======================================================================== */

export function generationHorizon(today: IsoDate): IsoDate {
  return addDays(today, GENERATION_LOOKAHEAD_DAYS);
}

/** The cron calls THIS. `=== buildSchedule(terms, generationHorizon(today))`. */
export function chargesDueForGeneration(terms: LeaseBillingTerms, today: IsoDate): PlannedCharge[] {
  return buildSchedule(terms, generationHorizon(today));
}

/* ======================================================================== */
/* validation, shared with the contract's superRefine                       */
/* ======================================================================== */

/**
 * Everything `chargesDueForGeneration` would write today, PLUS the period after the
 * one `today` falls in — and nothing beyond it.
 *
 * This is the landlord billing one month early on purpose: a tenant turns up on 27
 * Ashoj wanting to pay Kartik's rent before the scheduled run would create it. The
 * horizon is derived from the lease's own period grid rather than a date somebody
 * types, so the result stays a function of (terms, today) and repeating the action
 * writes nothing new.
 *
 * Exactly one period, deliberately. "Bill the next year upfront" freezes twelve
 * periods' terms against a rent that may still change, which is a different feature
 * with different consequences.
 */
export function chargesThroughNextPeriod(terms: LeaseBillingTerms, today: IsoDate): PlannedCharge[] {
  const anchor = maxIsoDate(terms.startDate, terms.ledgerStartDate);
  // Before the lease's own grid begins there is no "next" period to reach into; the
  // ordinary horizon already covers the opening stub.
  if (compareIsoDate(today, anchor) < 0) return chargesDueForGeneration(terms, today);

  const current = periodContaining(terms.frequency, anchor, today, terms.calendar);
  // One day past the current period's end lands inside the next one, whatever its
  // length — no month arithmetic, and correct in any calendar.
  return buildSchedule(terms, addDays(current.end, 1));
}

export function validateBillingTerms(terms: LeaseBillingTerms): string | null {
  if (terms.billingDay > MAX_BILLING_DAY[terms.calendar]) {
    return `billingDay must not exceed ${MAX_BILLING_DAY[terms.calendar]} for this calendar`;
  }
  if (terms.endDate !== null && compareIsoDate(terms.endDate, terms.startDate) < 0) {
    return 'endDate must not be before startDate';
  }
  if (compareIsoDate(terms.ledgerStartDate, terms.startDate) < 0) {
    return 'ledgerStartDate must not be before startDate';
  }
  if (terms.endDate !== null && compareIsoDate(terms.ledgerStartDate, terms.endDate) > 0) {
    return 'ledgerStartDate must not be after endDate';
  }
  const isAtStart = compareIsoDate(terms.ledgerStartDate, terms.startDate) === 0;
  if (!isAtStart && !isPeriodStart(terms.frequency, terms.startDate, terms.ledgerStartDate, terms.calendar)) {
    return 'ledgerStartDate must equal startDate or be the first day of a billing period';
  }
  if (terms.moveOutDate !== null && compareIsoDate(terms.moveOutDate, terms.startDate) < 0) {
    return 'moveOutDate must not be before startDate';
  }
  if (terms.rentSteps.length > 0) {
    let previousEffectiveFrom: IsoDate | null = null;
    for (const step of terms.rentSteps) {
      if (compareIsoDate(step.effectiveFrom, terms.startDate) <= 0) {
        return 'Each rent step must be strictly after startDate';
      }
      if (terms.endDate !== null && compareIsoDate(step.effectiveFrom, terms.endDate) > 0) {
        return 'Each rent step must not fall after endDate';
      }
      if (!isPeriodStart(terms.frequency, terms.startDate, step.effectiveFrom, terms.calendar)) {
        return 'Each rent step must fall on a billing period start';
      }
      if (previousEffectiveFrom !== null && compareIsoDate(step.effectiveFrom, previousEffectiveFrom) <= 0) {
        return 'rentSteps must be strictly ascending by effectiveFrom, with no duplicates';
      }
      if (step.rentCents < 0) {
        return 'rentCents must not be negative';
      }
      previousEffectiveFrom = step.effectiveFrom;
    }
  }
  return null;
}
