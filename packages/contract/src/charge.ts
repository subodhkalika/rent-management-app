import { z } from 'zod';
import { money, currency, uuid, pageQuery, isoDate, type IsoDate } from './common.js';
import { compareIsoDate } from './calendar/civil-days.js';
import { plannedCharge, type PlannedCharge } from './billing.js';

/**
 * A charge is a money document, not a derivation.
 *
 * Once written it is never updated and never deleted. The generator has exactly one
 * verb — insert, on conflict do nothing — so the question "may this period be
 * generated?" is always "is there a row?", which a unique index answers. A landlord
 * who needs a different number voids the charge and supersedes it; there is no path
 * that rewrites one in place, and there must not be one.
 */

export const chargeType = z.enum([
  'rent',
  'deposit',
  'opening_balance',
  'late_fee',
  'utility',
  'other',
]);
export type ChargeType = z.infer<typeof chargeType>;

export const chargeTypeLabels: Record<ChargeType, string> = {
  rent: 'Rent',
  deposit: 'Deposit',
  opening_balance: 'Opening balance',
  late_fee: 'Late fee',
  utility: 'Utility',
  other: 'Other',
};

/** `generated` means the scheduler wrote it; `manual` means a person did. */
export const chargeSource = z.enum(['generated', 'manual']);
export type ChargeSource = z.infer<typeof chargeSource>;

/**
 * Types a landlord may raise by hand.
 *
 * `rent` is absent deliberately: a manual rent charge would compete for a period the
 * generator owns, and the two would race over one generation key.
 */
export const manualChargeType = z.enum(['deposit', 'late_fee', 'utility', 'other']);
export type ManualChargeType = z.infer<typeof manualChargeType>;

/* ---------- responses ---------- */

export const charge = z.object({
  id: uuid,
  leaseId: uuid,
  type: chargeType,

  // The eleven PlannedCharge fields, stored whole rather than re-derived. A row that
  // explains its own number is what settles an argument about a prorated month.
  generationKey: z.string().nullable(),
  periodIndex: z.number().int().nullable(),
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  occupiedStart: isoDate.nullable(),
  occupiedEnd: isoDate.nullable(),
  daysOccupied: z.number().int().nullable(),
  daysInPeriod: z.number().int().nullable(),
  dueDate: isoDate,
  amountCents: money,
  isProrated: z.boolean(),

  currency,
  description: z.string().nullable(),
  source: chargeSource,

  supersedesChargeId: uuid.nullable(),
  voidedAt: z.string().datetime().nullable(),
  voidedReason: z.string().nullable(),

  /** Null means the generator wrote it, rather than a person. */
  createdByUserId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Charge = z.infer<typeof charge>;

/** A charge with enough lease context to be listed portfolio-wide. */
export const chargeWithLease = charge.extend({
  propertyId: uuid,
  propertyName: z.string(),
  unitId: uuid,
  unitLabel: z.string(),
  /** The property's timezone — overdue is decided in it, never in UTC. */
  propertyTimezone: z.string(),
});
export type ChargeWithLease = z.infer<typeof chargeWithLease>;

/* ---------- requests ---------- */

export const createChargeBody = z.object({
  type: manualChargeType,
  amountCents: money,
  dueDate: isoDate,
  periodStart: isoDate.optional(),
  periodEnd: isoDate.optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreateChargeBody = z.infer<typeof createChargeBody>;

/**
 * Voiding is the only mutation a charge accepts, and it always carries a reason.
 * The reason is the audit: a tenant asking why a line vanished deserves an answer
 * that exists somewhere other than in someone's memory.
 */
export const voidChargeBody = z.object({
  reason: z.string().trim().min(10, 'Say why in a sentence').max(500),
});
export type VoidChargeBody = z.infer<typeof voidChargeBody>;

/** Correcting voids the original and inserts a successor linked to it. */
export const correctChargeBody = z.object({
  amountCents: money,
  dueDate: isoDate.optional(),
  description: z.string().trim().max(500).optional(),
  reason: z.string().trim().min(10, 'Say why in a sentence').max(500),
});
export type CorrectChargeBody = z.infer<typeof correctChargeBody>;


/**
 * A boolean that arrives as a query string.
 *
 * `z.coerce.boolean()` is wrong for this and silently so: it is `Boolean(value)`, so
 * the string "false" — which is what a browser sends — parses as `true`. A flag that
 * cannot be switched off looks like a broken filter, not a parsing bug.
 */
export const queryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true'));

export const chargeListQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: chargeType.optional(),
  /**
   * Defaults to true. A ledger that silently hides rows is how an hour disappears
   * reconciling a total — the UI strikes voids through, it does not drop them.
   *
   * NOT `z.coerce.boolean()`. Query params arrive as strings and `Boolean("false")`
   * is `true`, so coercion made this flag impossible to turn off — and made
   * `diffChargesAgainstSchedule` work only by accident, since it needs the voided
   * rows the caller was explicitly asking to exclude.
   */
  includeVoided: queryBoolean.default(true),
});
export type ChargeListQuery = z.infer<typeof chargeListQuery>;

export const orgChargeListQuery = chargeListQuery.extend({
  propertyId: uuid.optional(),
  unitId: uuid.optional(),
  overdueOnly: queryBoolean.default(false),
});
export type OrgChargeListQuery = z.infer<typeof orgChargeListQuery>;

/* ---------- overdue ---------- */

/**
 * Overdue is a question about today, so it is computed, never stored — and `today`
 * must come from `localToday(property.timezone)`. A charge is not overdue because
 * UTC has rolled over.
 *
 * Deliberately not a status enum: 3b adds paid and partially paid, and an enum
 * shipped now would have to be widened then.
 */
export function chargeOverdue(dueDate: IsoDate, today: IsoDate): boolean {
  return compareIsoDate(dueDate, today) < 0;
}

/* ---------- the projection ---------- */

/**
 * Every field of `PlannedCharge`, as data.
 *
 * The API's mapper is checked against this, so adding a twelfth field to the engine
 * fails the build until a column exists for it — rather than silently dropping it on
 * the way into the database.
 */
export const PLANNED_CHARGE_KEYS = [
  'generationKey',
  'periodIndex',
  'periodStart',
  'periodEnd',
  'occupiedStart',
  'occupiedEnd',
  'daysOccupied',
  'daysInPeriod',
  'dueDate',
  'amountCents',
  'isProrated',
] as const satisfies readonly (keyof PlannedCharge)[];

/**
 * Recovers the PlannedCharge a stored row was written from.
 *
 * This is the other half of byte-identity: the conformance test maps real rows back
 * through this and compares them to the fixture that predicted them, so a value
 * mangled on its way through Postgres — a date returned as a timestamp, a bigint as
 * a string — fails loudly instead of quietly.
 */
export function plannedChargeFromCharge(c: Charge): PlannedCharge {
  return plannedCharge.parse({
    generationKey: c.generationKey,
    periodIndex: c.periodIndex,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    occupiedStart: c.occupiedStart,
    occupiedEnd: c.occupiedEnd,
    daysOccupied: c.daysOccupied,
    daysInPeriod: c.daysInPeriod,
    dueDate: c.dueDate,
    amountCents: c.amountCents,
    isProrated: c.isProrated,
  });
}

/* ---------- drift ---------- */

/**
 * What a written charge and the current schedule disagree about.
 *
 * The generator never un-writes, so when a landlord corrects a rent step or edits a
 * lease, rows already written keep their old numbers — by design. Something has to
 * make that visible, or the correction looks like it did nothing.
 *
 * This is deliberately NOT computed on the server and returned from the route that
 * caused it. Such a value is stale the moment anything else changes, and it would be
 * a second implementation of the comparison this contract already owns. Here, both
 * ends call one function over data they both already hold, and assert it against the
 * same fixtures.
 */
export const chargeDriftKind = z.enum(['amount', 'due_date', 'missing', 'unscheduled']);
export type ChargeDriftKind = z.infer<typeof chargeDriftKind>;

export const chargeDrift = z.object({
  kind: chargeDriftKind,
  generationKey: z.string(),
  /** Absent for `missing` — nothing was written for that period. */
  chargeId: uuid.nullable(),
  /** What the row says. Absent for `missing`. */
  actual: z.object({ amountCents: money, dueDate: isoDate }).nullable(),
  /** What the schedule says today. Absent for `unscheduled` — it wants no such period. */
  expected: z.object({ amountCents: money, dueDate: isoDate }).nullable(),
});
export type ChargeDrift = z.infer<typeof chargeDrift>;

/**
 * Compare the rent charges that exist against the schedule as it stands now.
 *
 * Pass EVERY generated rent charge for the lease, **including voided ones**. That is
 * not an oversight in the caller: a voided row still occupies its generation key —
 * `charge_generation_uq` has no predicate on `voided_at`, deliberately, so the
 * generator can never resurrect a charge somebody chose to void. A period whose only
 * row is voided is therefore *handled*, not missing, and reporting it as missing
 * would offer a "run generation" action that is guaranteed to write nothing.
 *
 * Manual charges may be passed or not; they have no generation key, so they are never
 * drift either way.
 *
 * The four kinds and what each means to a landlord:
 *   amount / due_date — written before a change; review and supersede if it matters
 *   missing           — the schedule wants a period nothing covers; run generation
 *   unscheduled       — a row exists for a period the schedule no longer has, which
 *                       happens when a lease is ended after the lookahead already
 *                       wrote past the new end; void it if it should not stand
 */
export function diffChargesAgainstSchedule(input: {
  charges: readonly Charge[];
  planned: readonly PlannedCharge[];
}): ChargeDrift[] {
  /** Keys any row holds, voided included — i.e. keys the generator can never fill. */
  const occupied = new Set<string>();
  /** Keys with a row that still stands, and is therefore comparable. */
  const liveByKey = new Map<string, Charge>();
  for (const c of input.charges) {
    if (c.generationKey === null) continue;
    occupied.add(c.generationKey);
    if (c.voidedAt === null) liveByKey.set(c.generationKey, c);
  }

  const out: ChargeDrift[] = [];
  const seen = new Set<string>();

  for (const p of input.planned) {
    if (p.generationKey === null) continue;
    seen.add(p.generationKey);
    const existing = liveByKey.get(p.generationKey);
    const expected = { amountCents: p.amountCents, dueDate: p.dueDate };

    // Voided, with or without a successor: a deliberate decision, and a key the
    // generator cannot reuse. Silent on purpose — a banner nobody can clear is noise
    // that trains people to ignore the ones that matter.
    if (!existing && occupied.has(p.generationKey)) continue;

    if (!existing) {
      out.push({ kind: 'missing', generationKey: p.generationKey, chargeId: null, actual: null, expected });
      continue;
    }
    const actual = { amountCents: existing.amountCents, dueDate: existing.dueDate };
    // Amount first: a wrong number matters more than a wrong date, and reporting both
    // for one period would make the banner count periods twice.
    if (actual.amountCents !== expected.amountCents) {
      out.push({ kind: 'amount', generationKey: p.generationKey, chargeId: existing.id, actual, expected });
    } else if (actual.dueDate !== expected.dueDate) {
      out.push({ kind: 'due_date', generationKey: p.generationKey, chargeId: existing.id, actual, expected });
    }
  }

  for (const [key, c] of liveByKey) {
    if (seen.has(key)) continue;
    out.push({
      kind: 'unscheduled',
      generationKey: key,
      chargeId: c.id,
      actual: { amountCents: c.amountCents, dueDate: c.dueDate },
      expected: null,
    });
  }

  // Stable, chronological: a banner that reorders itself between renders is unreadable.
  return out.sort((a, b) => (a.generationKey < b.generationKey ? -1 : a.generationKey > b.generationKey ? 1 : 0));
}
