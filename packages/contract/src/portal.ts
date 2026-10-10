import { z } from 'zod';
import { uuid, isoDate, money, currency, timezone } from './common.js';
import { address } from './property.js';
import { leaseStatus } from './lease.js';
import { rentFrequency, moveOutBillingPolicy, plannedCharge, rentEscalation } from './billing.js';
import { calendarSystem, MAX_BILLING_DAY_ANY } from './calendar/index.js';

/**
 * Tenant-facing responses.
 *
 * These are deliberately NOT the landlord shapes with fields removed — they are
 * separate types, so adding a landlord-private column can never leak through a
 * shared schema. `tenant.notes` in particular is landlord-private and appears
 * nowhere below.
 */

export const portalProfile = z.object({
  tenantId: uuid,
  orgId: z.string(),
  /** The landlord's organization name. */
  landlordName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  remindersOptedOut: z.boolean(),
});
export type PortalProfile = z.infer<typeof portalProfile>;

/** The only fields a tenant may change about themselves. */
export const updatePortalProfileBody = z.object({
  phone: z.string().trim().max(40).optional(),
  emergencyContactName: z.string().trim().max(200).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  remindersOptedOut: z.boolean().optional(),
});
export type UpdatePortalProfileBody = z.infer<typeof updatePortalProfileBody>;

/* ======================================================================== */
/* leases — tenant-facing                                                    */
/* ======================================================================== */

/**
 * No email. No phone. NO `tenantId` — structurally absent, not filtered, so a
 * co-tenant's identity can never be replayed against another route.
 */
export const portalCoTenant = z.object({
  firstName: z.string(),
  lastName: z.string(),
  isPrimary: z.boolean(),
  isCurrent: z.boolean(),
});
export type PortalCoTenant = z.infer<typeof portalCoTenant>;

/**
 * The actual ladder a tenant will be charged — `{ effectiveFrom, rentCents }`, and
 * NOTHING else. Deliberately not `rentStep` imported and reused: this is a separate
 * type, not the landlord shape with fields removed, so `note` (landlord-private),
 * `source` and `clauseExpectedCents` can never leak here by a later edit to the
 * landlord shape. See the escalation plan §4.7.
 */
export const portalRentStep = z.object({
  effectiveFrom: isoDate,
  rentCents: money,
});
export type PortalRentStep = z.infer<typeof portalRentStep>;

/**
 * Structurally absent from every portal lease shape: `notes`, `openingBalanceCents`,
 * `chainId`, `renewedFromLeaseId`, `endReason`, `createdBy`, and any co-tenant
 * contact detail. `openingBalanceCents` is withheld because a debt figure with no
 * ledger to explain it (Phase 3) is worse than no figure.
 */
export const portalLease = z.object({
  id: uuid,
  orgId: z.string(),
  /** The landlord's organization name. */
  landlordName: z.string(),
  status: leaseStatus,
  unitLabel: z.string(),
  propertyName: z.string(),
  propertyAddress: address,
  /** §1.8 — the client cannot be correct about "today" without this. */
  propertyTimezone: timezone,
  calendar: calendarSystem,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  moveOutDate: isoDate.nullable(),
  rentCents: z.number().int(),
  currency,
  rentFrequency,
  billingDay: z.number().int().min(1).max(MAX_BILLING_DAY_ANY),
  depositCents: z.number().int(),
  /**
   * The tenant sees it. Whether leaving early stops their rent is exactly the thing
   * they most need to know before giving notice, and withholding it would be worse
   * than showing it (Amendment A.5).
   */
  moveOutBillingPolicy,
  /** What was agreed. `null` = no clause. The actual ladder — what they will be
   *  charged — is `portalLeaseDetail.rentSteps`. No `note`, no `source`, no
   *  `clauseExpectedCents`, no correction history: we show the tenant what they will
   *  pay and what was agreed, not an editorial about the gap between them. */
  escalation: rentEscalation.nullable(),
  yourRole: z.enum(['current', 'former']),
  removedOn: isoDate.nullable(),
});
export type PortalLease = z.infer<typeof portalLease>;

export const portalLeaseDetail = portalLease.extend({
  coTenants: z.array(portalCoTenant),
  ledgerStartDate: isoDate,
  /** Ascending by `effectiveFrom`. The real numbers they will pay — see
   *  `portalRentStep` above. */
  rentSteps: z.array(portalRentStep),
});
export type PortalLeaseDetail = z.infer<typeof portalLeaseDetail>;

export const portalLeaseSchedule = z.object({
  leaseId: uuid,
  currency,
  computedThrough: isoDate,
  periods: z.array(plannedCharge),
});
export type PortalLeaseSchedule = z.infer<typeof portalLeaseSchedule>;

/* ---------- charges ---------- */

/**
 * A charge as the tenant sees it — their statement line, not the landlord's record.
 *
 * Separate from `charge` rather than that type with fields stripped, so a column added
 * on the landlord side can never reach a tenant by inheritance. Four things are
 * deliberately absent: `voidedReason` (landlord bookkeeping, and it may be unflattering
 * or mention another tenancy), the user ids behind a void or a creation (staff
 * identity), and `source`/`generationKey`/`periodIndex` (internal mechanics a tenant
 * has no use for).
 *
 * The proration fields ARE present. A prorated first or last month is the most
 * disputed number in renting, and "17 of 31 days" settles it without an email.
 */
export const portalCharge = z.object({
  id: uuid,
  leaseId: uuid,
  type: z.string(),
  description: z.string().nullable(),
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  daysOccupied: z.number().int().nullable(),
  daysInPeriod: z.number().int().nullable(),
  isProrated: z.boolean(),
  dueDate: isoDate,
  amountCents: money,
  currency,
  /** Whether, not when or why — they must see a line was cancelled or the statement
   *  does not add up, and the timestamp adds nothing they can act on. */
  isVoided: z.boolean(),
  /** Present so "$1,000 replaced by $900" reads as one correction, not two charges. */
  supersedesChargeId: uuid.nullable(),
});
export type PortalCharge = z.infer<typeof portalCharge>;

/* ---------- payments and balance ---------- */

/**
 * A payment as the tenant sees it.
 *
 * `note` is the most important omission: it is the landlord's private margin —
 * "paid late again, chase in person" — and it is the one mutable field on the table
 * precisely because it is not a document anyone else reads.
 *
 * `reference` IS kept. It is the tenant's own bank reference, and withholding the one
 * field that lets them match a line to their statement would make the page useless.
 */
export const portalPayment = z.object({
  id: uuid,
  leaseId: uuid,
  kind: z.enum(['payment', 'refund']),
  method: z.string(),
  amountCents: money,
  currency,
  receivedOn: isoDate,
  reference: z.string().nullable(),
  isVoided: z.boolean(),
  /** So "$1,200 replaced by $1,020" reads as one correction rather than two payments. */
  supersedesPaymentId: uuid.nullable(),
});
export type PortalPayment = z.infer<typeof portalPayment>;

/**
 * No signed balance, deliberately. A tenant reading "-500" has to work out which way
 * the minus points. `outstandingCents` and `creditCents` are mutually exclusive and
 * both non-negative, so the page says either "You owe $500" or "You are $500 in
 * credit" and never has to render a sign.
 */
export const portalBalance = z.object({
  leaseId: uuid,
  currency,
  asOfDate: isoDate,
  outstandingCents: z.number().int().nonnegative(),
  /** The same number arrears uses, without the word. */
  overdueCents: z.number().int().nonnegative(),
  depositOutstandingCents: z.number().int().nonnegative(),
  creditCents: z.number().int().nonnegative(),
  /** What they opened the page to find out. */
  nextDueDate: isoDate.nullable(),
  nextDueAmountCents: z.number().int().nonnegative().nullable(),
});
export type PortalBalance = z.infer<typeof portalBalance>;
