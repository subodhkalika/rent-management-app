import { z } from 'zod';
import { uuid, isoDate, money, currency, timezone, pageQuery } from './common.js';
import { address } from './property.js';
import { unitStatus } from './unit.js';
import {
  rentFrequency,
  moveOutBillingPolicy,
  plannedCharge,
  validateBillingTerms,
  compareIsoDate,
  rentStepSource,
  rentEscalation,
  rentEscalationMode,
  rentEscalationModeLabels,
  rentEscalationCompounding,
  rentEscalationCompoundingLabels,
  MAX_GENERATED_STEPS,
  type RentFrequency,
  type LeaseBillingTerms,
  type RentStep,
  type RentStepSource,
  type RentEscalation,
  type RentEscalationMode,
  type RentEscalationCompounding,
} from './billing.js';
import {
  calendarSystem,
  MAX_BILLING_DAY_ANY,
  type CalendarSystem,
} from './calendar/index.js';
import type { IsoDate } from './common.js';

/**
 * `billing.ts` owns `rentFrequency` and the pure schedule math; `lease.ts` owns the
 * lease lifecycle and re-exports `rentFrequency` so lease consumers need one import.
 * No cycle: `billing.ts` imports only `common.ts`.
 *
 * Same reasoning for the escalation surface: the clause (`rentEscalation` and its
 * mode/compounding enums) and `rentStepSource` live in `billing.ts` alongside the
 * generator that drafts a ladder from them; `lease.ts` re-exports them so a lease
 * consumer needs one import.
 */
export { rentFrequency, rentStepSource, rentEscalation, rentEscalationMode, rentEscalationModeLabels, rentEscalationCompounding, rentEscalationCompoundingLabels };
export type { RentFrequency, RentStepSource, RentEscalation, RentEscalationMode, RentEscalationCompounding };

/* ======================================================================== */
/* lifecycle enums                                                           */
/* ======================================================================== */

export const leaseStatus = z.enum(['draft', 'active', 'ended', 'terminated', 'cancelled']);
export type LeaseStatus = z.infer<typeof leaseStatus>;

export const leaseStatusLabels: Record<LeaseStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  ended: 'Ended',
  terminated: 'Terminated',
  cancelled: 'Cancelled',
};

export const endReason = z.enum([
  'term_ended',
  'renewed',
  'mutual',
  'tenant_notice',
  'landlord_notice',
  'breach',
  'eviction',
  'other',
]);
export type EndReason = z.infer<typeof endReason>;

export const endReasonLabels: Record<EndReason, string> = {
  term_ended: 'Term ended',
  renewed: 'Renewed',
  mutual: 'Mutual agreement',
  tenant_notice: 'Tenant notice',
  landlord_notice: 'Landlord notice',
  breach: 'Breach',
  eviction: 'Eviction',
  other: 'Other',
};

/**
 * Derives the resulting status from an end reason, so the dialog can say "this will
 * mark the lease Terminated" before the landlord commits, and the server derives the
 * status rather than trusting a client-chosen one.
 */
export function statusForEndReason(r: EndReason): 'ended' | 'terminated' {
  return r === 'breach' || r === 'eviction' ? 'terminated' : 'ended';
}

/* ======================================================================== */
/* rent steps — R2: the stored ladder, and the audit for correcting one      */
/*                                                                            */
/* The clause (`rentEscalation`, re-exported above) only ever drafts this    */
/* ladder — see `generateRentSteps` in `billing.ts`. The stored steps below  */
/* are the truth from the moment they are saved.                             */
/* ======================================================================== */

/**
 * What the client sends, for both `createLeaseBody.rentSteps` (the initial ladder)
 * and `putRentStepsBody` (replacing the whole ladder). `source` is what the CLIENT
 * says — `generateRentSteps` drafted this and nobody has touched it, or a human set
 * it — and the server trusts it only to the extent that it re-derives `'clause'`
 * steps from the lease's own clause rather than taking the client's number on faith.
 */
export const rentStepInput = z.object({
  effectiveFrom: isoDate,
  rentCents: money,
  source: rentStepSource,
  /** Landlord-private, e.g. "good tenant — 5% only". Structurally absent from
   *  every portal shape — see `portalRentStep` in `portal.ts`. */
  note: z.string().trim().max(500).optional(),
});
export type RentStepInput = z.infer<typeof rentStepInput>;

export const rentStepSummary = rentStepInput.extend({
  id: uuid,
  /** What the clause alone would have said at this cycle. Display only — drives the
   *  "agreed X, you set Y" line. NULL when there was no clause (the commercial,
   *  hand-entered case) or the step was never clause-drafted. */
  clauseExpectedCents: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RentStepSummary = z.infer<typeof rentStepSummary>;

/**
 * `PUT /v1/leases/:id/rent-steps` replaces the WHOLE ladder, not one step — the
 * client already holds the whole thing to render the cascade diff, and one endpoint
 * with one rule beats a patch endpoint plus a cascade endpoint.
 */
export const putRentStepsBody = z.object({
  steps: z.array(rentStepInput).max(MAX_GENERATED_STEPS),
});
export type PutRentStepsBody = z.infer<typeof putRentStepsBody>;

/**
 * `POST /v1/leases/:id/rent-steps/:stepId/correct` — only ever used on a step that
 * has ALREADY taken effect (a future step edits freely through `PUT`, unaudited).
 * `reason` is required and human-written, 10..500 characters — long enough to not be
 * a shrug, short enough to not be a form nobody fills in.
 */
export const correctRentStepBody = z.object({
  rentCents: money,
  reason: z.string().trim().min(10, 'Say why in at least 10 characters').max(500),
});
export type CorrectRentStepBody = z.infer<typeof correctRentStepBody>;

/**
 * One row of `GET /v1/leases/:id/rent-step-corrections` — the append-only audit of
 * every already-in-force step that was changed. Landlord-only: no portal shape ever
 * carries this (§4.7 of the escalation plan).
 */
export const rentStepCorrection = z.object({
  id: uuid,
  leaseId: uuid,
  stepId: uuid,
  effectiveFrom: isoDate,
  oldRentCents: z.number().int(),
  newRentCents: z.number().int(),
  reason: z.string(),
  correctedByUserId: z.string(),
  /** Resolved from the user table for display ("who"). Nullable so a deleted user
   *  account never breaks rendering an old correction. */
  correctedByName: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type RentStepCorrection = z.infer<typeof rentStepCorrection>;

/* ======================================================================== */
/* requests                                                                  */
/* ======================================================================== */

const createLeaseBodyShape = z.object({
  unitId: uuid,
  tenantIds: z.array(uuid).min(1, 'Add at least one tenant').max(8, 'A lease may carry at most 8 tenants'),
  primaryTenantId: uuid,
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  rentCents: money,
  rentFrequency,
  billingDay: z.number().int().min(1).max(MAX_BILLING_DAY_ANY).default(1),
  depositCents: money.default(0),
  /** Server defaults to `startDate` when omitted. */
  ledgerStartDate: isoDate.optional(),
  openingBalanceCents: money.default(0),
  /** Landlord-private. Structurally absent from every portal shape. */
  notes: z.string().trim().max(2000).optional(),
  /** `null` = no clause. Drafts no ladder on its own — `generateRentSteps` runs in
   *  the browser first, and the server runs the same function when `rentSteps` is
   *  omitted below. */
  escalation: rentEscalation.nullable().default(null),
  /**
   * The full ladder, in one call. Optional: when a clause is present and this is
   * omitted, the server drafts it with `generateRentSteps` — identical ladder either
   * way, because the generator lives in `packages/contract`. Calendar-dependent
   * ordering/period-start rules are enforced by `validateBillingTerms`, not here —
   * same reasoning as `endDate`/`ledgerStartDate` above.
   */
  rentSteps: z.array(rentStepInput).max(MAX_GENERATED_STEPS).optional(),
});

export function billingTermsFromCreateBody(
  data: {
    rentFrequency: RentFrequency;
    rentCents: number;
    billingDay: number;
    startDate: IsoDate;
    endDate?: IsoDate | null | undefined;
    ledgerStartDate?: IsoDate | undefined;
    rentSteps?: readonly RentStep[] | undefined;
  },
  /** From the property the unit belongs to. Never from the request body — a client
   *  choosing its own calendar would change what a billing period means. */
  calendar: CalendarSystem = 'gregorian',
): LeaseBillingTerms {
  return {
    frequency: data.rentFrequency,
    rentCents: data.rentCents,
    billingDay: data.billingDay,
    startDate: data.startDate,
    endDate: data.endDate ?? null,
    ledgerStartDate: data.ledgerStartDate ?? data.startDate,
    // No move-out exists yet at creation; irrelevant to validateBillingTerms's checks.
    moveOutDate: null,
    moveOutBillingPolicy: 'bill_full_term',
    calendar,
    rentSteps: data.rentSteps ? [...data.rentSteps] : [],
  };
}

export const createLeaseBody = createLeaseBodyShape.superRefine((data, ctx) => {
  if (!data.tenantIds.includes(data.primaryTenantId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['primaryTenantId'],
      message: 'primaryTenantId must be one of tenantIds',
    });
  }
  if (new Set(data.tenantIds).size !== data.tenantIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tenantIds'],
      message: 'Duplicate tenant ids',
    });
  }
  // Calendar-INDEPENDENT checks only. A request schema cannot see which property —
  // and therefore which calendar — the lease belongs to, and guessing Gregorian here
  // was actively harmful: it rejected a valid Bikram Sambat ledger start (a BS month
  // boundary is not a Gregorian one) and a valid billingDay of 32, before the
  // calendar-correct check could run. The intersection of "passes this guess" and
  // "passes the real check" was empty, so onboarding an in-flight tenancy was
  // unreachable on any Bikram Sambat property.
  //
  // The calendar-dependent rules live in `validateBillingTerms`, which the API calls
  // with the property's real calendar. Clients that know the calendar — the lease
  // wizard does — should call it directly for inline feedback.
  if (data.endDate && compareIsoDate(data.endDate, data.startDate) < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'End date cannot be before the start date',
    });
  }
  if (data.ledgerStartDate && compareIsoDate(data.ledgerStartDate, data.startDate) < 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ledgerStartDate'],
      message: 'Ledger start cannot be before the lease start date',
    });
  }
});
export type CreateLeaseBody = z.infer<typeof createLeaseBody>;

/**
 * Same terms as `createLeaseBody`, all optional, plus `moveOutDate`. Inherits
 * `escalation` — editable on any status but `cancelled`, per the escalation plan
 * §4.1: the clause is documentation and moves no money by itself.
 *
 * Roster changes (`tenantIds` / `primaryTenantId`) are their own routes, not folded
 * in here — see `addLeaseTenantBody` / `removeLeaseTenantBody`. A PATCH carrying a
 * full roster array cannot express *when* someone left, which is the entire point of
 * `removed_on`. [CORRECTION] to PLAN-V1 §3.4.
 *
 * `rentSteps` is deliberately OMITTED here, not inherited: `PUT /rent-steps` owns the
 * ladder, so a PATCH can never half-write it.
 */
export const updateLeaseBody = createLeaseBodyShape
  .omit({ tenantIds: true, primaryTenantId: true, rentSteps: true })
  .partial()
  .extend({
    moveOutDate: isoDate.nullable().optional(),
  });
export type UpdateLeaseBody = z.infer<typeof updateLeaseBody>;

export const endLeaseBody = z.object({
  endDate: isoDate,
  moveOutDate: isoDate.nullable().optional(),
  reason: endReason,
  note: z.string().trim().max(2000).optional(),
});
export type EndLeaseBody = z.infer<typeof endLeaseBody>;

export const renewLeaseBody = z.object({
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  rentCents: money,
  /** Defaults to the predecessor's. Supplying a different one is the supported way
   *  to change cadence — `rentFrequency` is otherwise immutable on an active lease. */
  rentFrequency: rentFrequency.optional(),
  billingDay: z.number().int().min(1).max(MAX_BILLING_DAY_ANY).optional(),
  depositCents: money.optional(),
  /** Defaults to the predecessor's live roster (`removed_on IS NULL`). */
  carryTenantIds: z.array(uuid).optional(),
  /** Defaults to the predecessor's primary. */
  primaryTenantId: uuid.optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Defaults to the predecessor's clause (assumption §9.2.3 of the escalation
   *  plan: a renewal carries the clause forward and re-anchors on its own start). */
  escalation: rentEscalation.nullable().optional(),
  /** Defaults to a ladder generated from the renewal's OWN clause and base rent —
   *  same `generateRentSteps` call the server makes on create when this is omitted. */
  rentSteps: z.array(rentStepInput).max(MAX_GENERATED_STEPS).optional(),
});
export type RenewLeaseBody = z.infer<typeof renewLeaseBody>;

export const cancelLeaseBody = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelLeaseBody = z.infer<typeof cancelLeaseBody>;

export const addLeaseTenantBody = z.object({
  tenantId: uuid,
  isPrimary: z.boolean().default(false),
  addedOn: isoDate.optional(),
});
export type AddLeaseTenantBody = z.infer<typeof addLeaseTenantBody>;

export const removeLeaseTenantBody = z.object({
  /** Defaults to `localToday(property.timezone)` server-side when omitted — the one
   *  place in Phase 2 that reads the clock, and it reads it in the property's zone. */
  removedOn: isoDate.optional(),
});
export type RemoveLeaseTenantBody = z.infer<typeof removeLeaseTenantBody>;

export const leaseListQuery = pageQuery.extend({
  status: leaseStatus.optional(),
  unitId: uuid.optional(),
  propertyId: uuid.optional(),
  tenantId: uuid.optional(),
});
export type LeaseListQuery = z.infer<typeof leaseListQuery>;

/**
 * `through` is validated against the lease's own `startDate` (must be within 10
 * years of it) by the ROUTE, not here — this schema alone has no access to the
 * lease row. See `billing.ts`'s `MAX_SCHEDULE_PERIODS` / §1.5 for why that check
 * exists: it keeps `buildSchedule`'s `RangeError` ceiling unreachable in practice.
 */
export const scheduleQuery = z.object({
  through: isoDate,
});
export type ScheduleQuery = z.infer<typeof scheduleQuery>;

/* ======================================================================== */
/* responses                                                                 */
/* ======================================================================== */

export const leaseTenantSummary = z.object({
  tenantId: uuid,
  firstName: z.string(),
  lastName: z.string(),
  isPrimary: z.boolean(),
  addedOn: isoDate,
  removedOn: isoDate.nullable(),
});
export type LeaseTenantSummary = z.infer<typeof leaseTenantSummary>;

export const leaseSummary = z.object({
  id: uuid,
  chainId: uuid,
  status: leaseStatus,
  unitId: uuid,
  unitLabel: z.string(),
  propertyId: uuid,
  propertyName: z.string(),
  /** §1.8 — the client cannot be correct about "today" without this. */
  propertyTimezone: timezone,
  /** The property's calendar. Decides what a billing period is, so the client
   *  needs it to preview a schedule that matches what the server will bill. */
  calendar: calendarSystem,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  moveOutDate: isoDate.nullable(),
  rentCents: z.number().int(),
  currency,
  rentFrequency,
  billingDay: z.number().int().min(1).max(MAX_BILLING_DAY_ANY),
  depositCents: z.number().int(),
  openingBalanceCents: z.number().int(),
  ledgerStartDate: isoDate,
  /** Resolved LIVE from the property on every read. No column on `lease` — see
   *  Amendment A.3. Read together with `billingTermsFor` to preview the schedule. */
  moveOutBillingPolicy,
  /** `null` = no clause. Documentation only — it moves no money by itself; the
   *  stored `rentSteps` (on `leaseDetail`) are what the schedule reads. */
  escalation: rentEscalation.nullable(),
  tenantCount: z.number().int().nonnegative(),
  primaryTenantName: z.string().nullable(),
  renewedFromLeaseId: uuid.nullable(),
  endReason: endReason.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LeaseSummary = z.infer<typeof leaseSummary>;

/** Every write route returns this. */
export const lease = leaseSummary;
export type Lease = z.infer<typeof lease>;

export const leaseChainEntry = z.object({
  id: uuid,
  status: leaseStatus,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  rentCents: z.number().int(),
});
export type LeaseChainEntry = z.infer<typeof leaseChainEntry>;

export const leaseDetail = leaseSummary.extend({
  tenants: z.array(leaseTenantSummary),
  /** Landlord-private. Detail only — never on `leaseSummary`, never on any portal shape. */
  notes: z.string().nullable(),
  unitStatus,
  propertyAddress: address,
  /** One query on `chain_id`. */
  chain: z.array(leaseChainEntry),
  /** Ascending by `effectiveFrom`. Empty = a constant rent. Kept off `leaseSummary`
   *  to keep the list light — see the escalation plan §4.2. */
  rentSteps: z.array(rentStepSummary),
});
export type LeaseDetail = z.infer<typeof leaseDetail>;

export const leaseSchedule = z.object({
  leaseId: uuid,
  currency,
  computedThrough: isoDate,
  /** Imported from `billing.ts`, not redeclared — the pure function's return type
   *  and the wire shape are the same zod object, so they cannot drift. */
  periods: z.array(plannedCharge),
});
export type LeaseSchedule = z.infer<typeof leaseSchedule>;

/* ======================================================================== */
/* the construction adapter — the ONLY sanctioned way to build billing terms */
/* ======================================================================== */

/**
 * Neither the API nor the browser hand-assembles a `LeaseBillingTerms` object.
 * Both call this, then pass the result straight to `buildSchedule`. One adapter,
 * one derivation, zero call-site logic (Amendment A.2).
 *
 * Also works on a `PortalLeaseDetail` (or any shape carrying the same field names,
 * `rentSteps` included) — `leaseSummary` does not itself carry `rentSteps` (kept off
 * the list to stay light, per the escalation plan §4.2), so the argument type widens
 * to an intersection rather than a bare `Pick<LeaseSummary, …>`: any caller holding a
 * `leaseDetail`-shaped row (whose `rentStepSummary[]` satisfies `RentStep[]`
 * structurally) or a hand-built object with the same fields may pass it here.
 */
export function billingTermsFor(
  lease: Pick<
    LeaseSummary & { rentSteps: readonly RentStep[] },
    | 'rentFrequency'
    | 'rentCents'
    | 'billingDay'
    | 'startDate'
    | 'endDate'
    | 'ledgerStartDate'
    | 'moveOutDate'
    | 'moveOutBillingPolicy'
    | 'calendar'
    | 'rentSteps'
  >,
): LeaseBillingTerms {
  return {
    frequency: lease.rentFrequency,
    rentCents: lease.rentCents,
    billingDay: lease.billingDay,
    startDate: lease.startDate,
    endDate: lease.endDate,
    ledgerStartDate: lease.ledgerStartDate,
    moveOutDate: lease.moveOutDate,
    moveOutBillingPolicy: lease.moveOutBillingPolicy,
    calendar: lease.calendar,
    rentSteps: [...lease.rentSteps],
  };
}
