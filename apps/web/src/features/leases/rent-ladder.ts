import {
  compareIsoDate,
  rentForPeriodStart,
  rentEscalationCompoundingLabels,
  type RentEscalation,
  type DraftRentStep,
  type RentStepInput,
  type IsoDate,
} from '@rms/contract';

/**
 * Percent <-> basis-point conversion, at the form edge ONLY — see the escalation
 * plan §6.2 item 1. `Math.round` is load-bearing: `7.35 * 100 === 734.9999999999999`
 * in plain JS float math, and a truncating conversion would silently store `734`
 * bps instead of `735`. Every basis-point value that reaches the contract — the
 * clause's `rateBps`, `generateRentSteps`, `recomputeLadderFrom` — comes from this
 * function or from a value the server already returned; nothing else in this app
 * converts a percentage to basis points.
 */
export function percentToBps(pct: number): number {
  return Math.round(pct * 100);
}

/** The inverse, for displaying a stored `rateBps` back as an editable percentage.
 *  `bps / 100` round-trips exactly for every integer bps value JS can represent at
 *  this scale — there is no precision loss on this side of the conversion. */
export function bpsToPercent(bps: number): number {
  return bps / 100;
}

/** Strips the drafting metadata (`source`, `clauseExpectedCents`) a `DraftRentStep`
 *  carries for display, down to the `rentStepInput` shape the API accepts on
 *  `POST /v1/leases` and `PUT /v1/leases/:id/rent-steps`. `note` is preserved when
 *  present so a landlord's comment on a step survives a cascade. */
export function toRentStepInput(steps: readonly DraftRentStep[]): RentStepInput[] {
  return steps.map((s) => ({
    effectiveFrom: s.effectiveFrom,
    rentCents: s.rentCents,
    source: s.source,
    ...('note' in s && typeof (s as { note?: unknown }).note === 'string'
      ? { note: (s as { note: string }).note }
      : {}),
  }));
}

/**
 * The rent in force today, read the same way `rentForPeriodStart` reads it
 * everywhere else — a pure lookup over the stored/drafted steps, never a
 * recomputation. This is what backs the "Rent today" figure next to the "Rent at
 * lease start" field (escalation plan §6.3) and the live ladder preview.
 *
 * `rentForPeriodStart` only ever reads `rentCents` and `rentSteps` off the object
 * it is given — see `packages/contract/src/billing.ts` — so the other
 * `LeaseBillingTerms` fields below are structurally required but not actually
 * consulted. They are filled with `asOf` / neutral defaults rather than threading
 * the lease's real frequency/calendar through a call site that does not need them.
 */
export function currentRentCents(
  baseRentCents: number,
  steps: readonly { effectiveFrom: IsoDate; rentCents: number }[],
  asOf: IsoDate,
): number {
  return rentForPeriodStart(
    {
      frequency: 'monthly',
      billingDay: 1,
      startDate: asOf,
      endDate: null,
      ledgerStartDate: asOf,
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
      rentCents: baseRentCents,
      rentSteps: steps.map((s) => ({ effectiveFrom: s.effectiveFrom, rentCents: s.rentCents })),
    },
    asOf,
  );
}

/**
 * Re-drafting the ladder after a clause-level change (the rate, the interval, the
 * compounding, or the base rent itself) — as opposed to overriding one step's own
 * value, which goes through `recomputeLadderFrom` and the cascade-diff dialog
 * instead (escalation plan §4.4). A manual step is matched back onto the freshly
 * generated ladder BY DATE and kept verbatim: changing the rate or the base does
 * not move any step's date, so every existing manual override still has a home in
 * the new ladder. Changing the INTERVAL does move the dates, so a manual step whose
 * date no longer exists in the fresh ladder has nothing to attach to and is
 * dropped — there is no sensible place left to show it.
 */
export function mergeDraftWithManualOverrides(
  fresh: readonly DraftRentStep[],
  previous: readonly DraftRentStep[],
): DraftRentStep[] {
  const manualByDate = new Map(previous.filter((s) => s.source === 'manual').map((s) => [s.effectiveFrom, s]));
  return fresh.map((step) => manualByDate.get(step.effectiveFrom) ?? step);
}

/** Landlord-language summary of a clause, e.g. "10% every year, compounds on the
 *  previous rent" — used on the lease detail terms row and the portal. `null`
 *  reads as "No scheduled rent increase" rather than being left blank. */
export function escalationSummary(clause: RentEscalation | null): string {
  if (!clause) return 'No scheduled rent increase';
  const pct = bpsToPercent(clause.rateBps);
  const every = clause.intervalYears === 1 ? 'year' : `${clause.intervalYears} years`;
  return `${pct}% every ${every} — ${rentEscalationCompoundingLabels[clause.compounding].toLowerCase()}`;
}

/** The first step whose `effectiveFrom` is strictly after `today` — "finding the
 *  next row in a sorted array is not date arithmetic" (escalation plan §6.4): a
 *  single `compareIsoDate` call, not a calendar computation. */
export function nextIncrease<T extends { effectiveFrom: IsoDate }>(steps: readonly T[], today: IsoDate): T | null {
  return steps.find((s) => compareIsoDate(s.effectiveFrom, today) > 0) ?? null;
}

/** Whether a step has already taken effect — the one date comparison the
 *  escalation plan hangs the whole correct-vs-edit distinction on (§4.5). */
export function hasTakenEffect(effectiveFrom: IsoDate, today: IsoDate): boolean {
  return compareIsoDate(effectiveFrom, today) <= 0;
}

/** The percentage difference of `actual` from `expected`, for the "agreed X, you
 *  set Y −N%" line (escalation plan §4.4 / §6.2). `null` when there is nothing to
 *  compare against (no clause, or the step still matches the clause exactly). */
export function variancePercent(expectedCents: number | null, actualCents: number): number | null {
  if (expectedCents === null || expectedCents === 0 || expectedCents === actualCents) return null;
  return ((actualCents - expectedCents) / expectedCents) * 100;
}
