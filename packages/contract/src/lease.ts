import { z } from 'zod';
import { uuid, isoDate, money, currency, timezone, pageQuery } from './common.js';
import { address } from './property.js';
import { unitStatus } from './unit.js';
import {
  rentFrequency,
  moveOutBillingPolicy,
  plannedCharge,
  validateBillingTerms,
  type RentFrequency,
  type LeaseBillingTerms,
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
 */
export { rentFrequency };
export type { RentFrequency };

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
});

function billingTermsFromCreateBody(
  data: {
    rentFrequency: RentFrequency;
    rentCents: number;
    billingDay: number;
    startDate: IsoDate;
    endDate?: IsoDate | null | undefined;
    ledgerStartDate?: IsoDate | undefined;
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
  const error = validateBillingTerms(billingTermsFromCreateBody(data));
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ledgerStartDate'], message: error });
  }
});
export type CreateLeaseBody = z.infer<typeof createLeaseBody>;

/**
 * Same terms as `createLeaseBody`, all optional, plus `moveOutDate`.
 *
 * Roster changes (`tenantIds` / `primaryTenantId`) are their own routes, not folded
 * in here — see `addLeaseTenantBody` / `removeLeaseTenantBody`. A PATCH carrying a
 * full roster array cannot express *when* someone left, which is the entire point of
 * `removed_on`. [CORRECTION] to PLAN-V1 §3.4.
 */
export const updateLeaseBody = createLeaseBodyShape
  .omit({ tenantIds: true, primaryTenantId: true })
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
 * Also works on a `PortalLease`, because it carries the same field names.
 */
export function billingTermsFor(
  lease: Pick<
    LeaseSummary,
    | 'rentFrequency'
    | 'rentCents'
    | 'billingDay'
    | 'startDate'
    | 'endDate'
    | 'ledgerStartDate'
    | 'moveOutDate'
    | 'moveOutBillingPolicy'
    | 'calendar'
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
  };
}
