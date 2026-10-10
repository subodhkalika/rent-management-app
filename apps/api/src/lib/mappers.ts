import {
  chargeStatusFor,
  type Property,
  type Unit,
  type Tenant,
  type PortalAccess,
  type PortalProfile,
  type LeaseSummary,
  type LeaseDetail,
  type LeaseTenantSummary,
  type PortalLease,
  type PortalLeaseDetail,
  type RentStepSummary,
  type RentStepCorrection,
  type PortalRentStep,
  type Charge,
  type ChargeWithLease,
  type PortalCharge,
  type Payment,
  type PortalPayment,
  type AllocatedCharge,
  type LedgerEntry,
  type LedgerLease,
  type ChainBalance,
  type LeaseBalanceSlice,
  type LeaseBalanceResponse,
  type ArrearsRow,
  type ArrearsGroup,
  type ArrearsResponse,
  type PortalBalance,
  type IsoDate,
} from '@rms/contract';
import type { PropertyRow } from '../db/repo/property.js';
import type { UnitRow } from '../db/repo/unit.js';
import type { TenantRow } from '../db/repo/tenant.js';
import type { PortalProfileRow } from '../db/repo/portal/profile.js';
import {
  escalationFromRow,
  type LeaseRow,
  type LeaseDetailRow,
  type LeaseTenantRow,
  type RentStepRow,
  type RentStepCorrectionRow,
} from '../db/repo/lease.js';
import type { PortalLeaseRow, PortalLeaseDetailRow } from '../db/repo/portal/lease.js';
import type { ChargeRow, ChargeWithLeaseRow } from '../db/repo/charge.js';
import type {
  AllocatedChargeRow,
  LedgerLeaseRow,
  RawLedgerEntry,
  ChainBalanceResult,
  LeaseBalanceSliceResult,
  LeaseAndChainBalance,
  ArrearsChainRow,
} from '../db/repo/ledger.js';
import type { PortalBalanceResult } from '../db/repo/portal/balance.js';

/**
 * Explicit DB row -> contract type mapping. Never spread a row into a response —
 * an internal column (e.g. a future `orgId` or `deletedAt`) must not leak just
 * because someone added it to the table.
 */
export function mapProperty(row: PropertyRow): Property {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    address: {
      line1: row.addressLine1,
      line2: row.addressLine2 ?? undefined,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
    },
    notes: row.notes,
    timezone: row.timezone,
    moveOutBillingPolicy: row.moveOutBillingPolicy,
    calendar: row.calendar,
    unitCount: row.unitCount,
    occupiedUnitCount: row.occupiedUnitCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Derives the contract's `portalAccess` enum from the tenant row's own `userId` plus
 * the most recent invite's state (`db/repo/tenant.ts`'s `tenantColumns` join).
 *
 * Pulled out as its own small, pure function rather than a SQL `CASE` so the state
 * machine is something a test can enumerate exhaustively (see mappers.test.ts)
 * instead of something only provable by querying a live database.
 */
export function derivePortalAccess(
  input: {
    userId: string | null;
    latestInviteAcceptedAt: Date | null;
    latestInviteRevokedAt: Date | null;
    latestInviteExpiresAt: Date | null;
  },
  now: Date = new Date(),
): PortalAccess {
  if (input.userId) return 'active';
  // Was accepted once (so a login existed), but the tenant row is unbound now — this
  // is specifically the `DELETE /v1/tenants/:id/portal-access` kill switch having run.
  if (input.latestInviteAcceptedAt) return 'revoked';
  if (input.latestInviteRevokedAt) return 'revoked';
  if (input.latestInviteExpiresAt && input.latestInviteExpiresAt > now) return 'invited';
  // No invite ever sent, or the most recent one lapsed without being accepted or
  // revoked — in both cases the landlord can just invite (again), so the tenant
  // reads as 'none' rather than inventing a fifth ("expired") state the contract
  // doesn't have.
  return 'none';
}

export function mapTenant(row: TenantRow): Tenant {
  const access = derivePortalAccess(row);
  // `invitedEmail`/`inviteExpiresAt` are non-null only while the tenant reads as
  // 'invited' — every other state (none/active/revoked) means the most recent
  // invite, if any, is no longer live, so surfacing its email/expiry would show a
  // landlord a link that can no longer be accepted.
  const invited = access === 'invited';
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    notes: row.notes,
    status: row.status,
    portalAccess: access,
    portalEmail: row.portalEmail,
    invitedEmail: invited ? row.latestInviteEmail : null,
    inviteExpiresAt: invited && row.latestInviteExpiresAt ? row.latestInviteExpiresAt.toISOString() : null,
    remindersOptedOut: row.remindersOptedOut,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapPortalProfile(row: PortalProfileRow): PortalProfile {
  return {
    tenantId: row.tenantId,
    orgId: row.orgId,
    landlordName: row.orgName,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    remindersOptedOut: row.remindersOptedOut,
  };
}

export function mapUnit(row: UnitRow): Unit {
  return {
    id: row.id,
    propertyId: row.propertyId,
    label: row.label,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    squareFeet: row.squareFeet,
    marketRentCents: row.marketRentCents,
    currency: row.currency as Unit['currency'],
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapLeaseTenant(row: LeaseTenantRow): LeaseTenantSummary {
  return {
    tenantId: row.tenantId,
    firstName: row.firstName,
    lastName: row.lastName,
    isPrimary: row.isPrimary,
    addedOn: row.addedOn,
    removedOn: row.removedOn,
  };
}

export function mapLeaseSummary(row: LeaseRow): LeaseSummary {
  return {
    id: row.id,
    chainId: row.chainId,
    status: row.status,
    unitId: row.unitId,
    unitLabel: row.unitLabel,
    propertyId: row.propertyId,
    propertyName: row.propertyName,
    propertyTimezone: row.propertyTimezone,
    calendar: row.calendar,
    startDate: row.startDate,
    endDate: row.endDate,
    moveOutDate: row.moveOutDate,
    rentCents: row.rentCents,
    currency: row.currency as LeaseSummary['currency'],
    rentFrequency: row.rentFrequency,
    billingDay: row.billingDay,
    depositCents: row.depositCents,
    openingBalanceCents: row.openingBalanceCents,
    ledgerStartDate: row.ledgerStartDate,
    moveOutBillingPolicy: row.moveOutBillingPolicy,
    // Documentation only — moves no money by itself. See the module comment on
    // `db/repo/lease.ts`'s rent-step section: the stored `rentSteps` (below, on
    // `leaseDetail` only) are what the schedule reads.
    escalation: escalationFromRow(row),
    tenantCount: row.tenantCount,
    primaryTenantName: row.primaryTenantName,
    renewedFromLeaseId: row.renewedFromLeaseId,
    endReason: row.endReason as LeaseSummary['endReason'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `lease_rent_step` row -> the landlord-facing `rentStepSummary` (packages/
 *  contract/src/lease.ts). `note` is `undefined`, never `null`, when absent —
 *  `rentStepInput.note` is `.optional()`, not `.nullable()`. */
export function mapRentStep(row: RentStepRow): RentStepSummary {
  return {
    id: row.id,
    effectiveFrom: row.effectiveFrom,
    rentCents: row.rentCents,
    source: row.source,
    note: row.note ?? undefined,
    clauseExpectedCents: row.clauseExpectedCents,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `lease_rent_step_correction` row -> the landlord-only audit entry. Never on
 *  any portal shape (escalation plan §4.7). */
export function mapRentStepCorrection(row: RentStepCorrectionRow): RentStepCorrection {
  return {
    id: row.id,
    leaseId: row.leaseId,
    stepId: row.stepId,
    effectiveFrom: row.effectiveFrom,
    oldRentCents: row.oldRentCents,
    newRentCents: row.newRentCents,
    reason: row.reason,
    correctedByUserId: row.correctedByUserId,
    correctedByName: row.correctedByName,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The actual ladder a tenant will be charged — `{ effectiveFrom, rentCents }`
 *  and NOTHING else (escalation plan §4.7 / `portal.ts`'s own comment on
 *  `portalRentStep`). No `note`, no `source`, no `clauseExpectedCents`. */
export function mapPortalRentStep(row: { effectiveFrom: string; rentCents: number }): PortalRentStep {
  return {
    effectiveFrom: row.effectiveFrom,
    rentCents: row.rentCents,
  };
}

export function mapLeaseDetail(row: LeaseDetailRow): LeaseDetail {
  return {
    ...mapLeaseSummary(row),
    tenants: row.tenants.map(mapLeaseTenant),
    notes: row.notes,
    unitStatus: row.unitStatus,
    propertyAddress: {
      line1: row.addressLine1,
      line2: row.addressLine2 ?? undefined,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
    },
    chain: row.chain.map((c) => ({
      id: c.id,
      status: c.status,
      startDate: c.startDate,
      endDate: c.endDate,
      rentCents: c.rentCents,
    })),
    // Ascending by effectiveFrom (the repo's own `listRentSteps` ordering, I20).
    rentSteps: row.rentSteps.map(mapRentStep),
  };
}

/** `yourRole`/`removedOn` derive from the SAME `removed_on` column — pulled out as
 *  a one-line pure function so the derivation cannot drift between the two fields
 *  (docs/PLAN-PHASE2.md §5.6). */
function portalYourRole(removedOn: string | null): 'current' | 'former' {
  return removedOn === null ? 'current' : 'former';
}

export function mapPortalLease(row: PortalLeaseRow): PortalLease {
  return {
    id: row.id,
    orgId: row.orgId,
    landlordName: row.landlordName,
    status: row.status,
    unitLabel: row.unitLabel,
    propertyName: row.propertyName,
    propertyAddress: {
      line1: row.addressLine1,
      line2: row.addressLine2 ?? undefined,
      city: row.city,
      region: row.region,
      postalCode: row.postalCode,
      country: row.country,
    },
    propertyTimezone: row.propertyTimezone,
    calendar: row.calendar,
    startDate: row.startDate,
    endDate: row.endDate,
    moveOutDate: row.moveOutDate,
    rentCents: row.rentCents,
    currency: row.currency as PortalLease['currency'],
    rentFrequency: row.rentFrequency,
    billingDay: row.billingDay,
    depositCents: row.depositCents,
    moveOutBillingPolicy: row.moveOutBillingPolicy,
    // What was agreed — documentation only. The actual ladder the tenant will be
    // charged is `portalLeaseDetail.rentSteps` below (escalation plan §4.7).
    escalation: escalationFromRow(row),
    yourRole: portalYourRole(row.removedOn),
    removedOn: row.removedOn,
  };
}

export function mapPortalLeaseDetail(row: PortalLeaseDetailRow): PortalLeaseDetail {
  return {
    ...mapPortalLease(row),
    coTenants: row.coTenants.map((c) => ({
      firstName: c.firstName,
      lastName: c.lastName,
      isPrimary: c.isPrimary,
      isCurrent: c.isCurrent,
    })),
    ledgerStartDate: row.ledgerStartDate,
    // The real numbers they will pay. No note, no source, no clauseExpectedCents
    // — a separate type from the landlord shape, not the landlord shape with
    // fields removed (portal.ts's own comment on `portalRentStep`).
    rentSteps: row.rentSteps.map(mapPortalRentStep),
  };
}

/**
 * A charge row explains its own number — every one of `PlannedCharge`'s eleven
 * fields is read by name, never spread, so an internal column (`voidedByUserId` is
 * deliberately NOT part of `charge` — see `charge.ts`'s own schema) can never leak
 * just because it exists on the row.
 */
export function mapCharge(row: ChargeRow): Charge {
  return {
    id: row.id,
    leaseId: row.leaseId,
    type: row.type,
    generationKey: row.generationKey,
    periodIndex: row.periodIndex,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    occupiedStart: row.occupiedStart,
    occupiedEnd: row.occupiedEnd,
    daysOccupied: row.daysOccupied,
    daysInPeriod: row.daysInPeriod,
    dueDate: row.dueDate,
    amountCents: row.amountCents,
    isProrated: row.isProrated,
    currency: row.currency as Charge['currency'],
    description: row.description,
    source: row.source,
    supersedesChargeId: row.supersedesChargeId,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedReason: row.voidedReason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `charge` plus the lease context `GET /v1/charges` needs to render a
 *  portfolio-wide row (property/unit, and the timezone "overdue" is decided in). */
export function mapChargeWithLease(row: ChargeWithLeaseRow): ChargeWithLease {
  return {
    ...mapCharge(row),
    propertyId: row.propertyId,
    propertyName: row.propertyName,
    unitId: row.unitId,
    unitLabel: row.unitLabel,
    propertyTimezone: row.propertyTimezone,
  };
}

/**
 * The tenant's statement line — a SEPARATE type from `charge`, not that type with
 * fields removed (portal.ts's own comment on `portalCharge`). No `voidedReason`
 * (landlord bookkeeping), no user ids (staff identity), no `source`/
 * `generationKey`/`periodIndex` (internal mechanics) — `voidedAt` becomes a plain
 * `isVoided` boolean: whether a line was cancelled, not when or why.
 */
export function mapPortalCharge(row: ChargeRow): PortalCharge {
  return {
    id: row.id,
    leaseId: row.leaseId,
    type: row.type,
    description: row.description,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    daysOccupied: row.daysOccupied,
    daysInPeriod: row.daysInPeriod,
    isProrated: row.isProrated,
    dueDate: row.dueDate,
    amountCents: row.amountCents,
    currency: row.currency as PortalCharge['currency'],
    isVoided: row.voidedAt !== null,
    supersedesChargeId: row.supersedesChargeId,
  };
}

/* ======================================================================== *
 * payments, the ledger and balances (PLAN-PHASE3B.md) — allocation is DERIVED,
 * never stored. Every mapper below shapes a row that `repo/ledger.ts`'s one
 * window function already produced; none of them allocate anything themselves.
 * ======================================================================== */

/** The exact subset `mapPayment`/`mapPortalPayment` need — satisfied by BOTH
 *  `repo/payment.ts`'s own `PaymentRow` (the lease-scoped list/resolve shape)
 *  and `repo/ledger.ts`'s `ChainPaymentRow` (the whole-chain ledger shape),
 *  which differ only in `voidedByUserId` — never surfaced to either actor. */
interface PaymentMappable {
  id: string;
  leaseId: string;
  kind: Payment['kind'];
  method: Payment['method'];
  amountCents: number;
  currency: string;
  receivedOn: string;
  reference: string | null;
  note: string | null;
  supersedesPaymentId: string | null;
  voidedAt: Date | null;
  voidedReason: string | null;
  recordedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export function mapPayment(row: PaymentMappable): Payment {
  return {
    id: row.id,
    leaseId: row.leaseId,
    kind: row.kind,
    method: row.method,
    amountCents: row.amountCents,
    currency: row.currency as Payment['currency'],
    receivedOn: row.receivedOn,
    reference: row.reference,
    note: row.note,
    supersedesPaymentId: row.supersedesPaymentId,
    voidedAt: row.voidedAt ? row.voidedAt.toISOString() : null,
    voidedReason: row.voidedReason,
    recordedByUserId: row.recordedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The tenant's own statement line. `note` and `voidedReason` are the two
 * deliberate omissions (portal.ts's own comment on `portalPayment`) — the
 * landlord's private margin and a reason that may be unflattering or name
 * another tenancy. `voidedAt` becomes a plain `isVoided`: whether, not when.
 */
export function mapPortalPayment(row: PaymentMappable): PortalPayment {
  return {
    id: row.id,
    leaseId: row.leaseId,
    kind: row.kind,
    method: row.method,
    amountCents: row.amountCents,
    currency: row.currency as PortalPayment['currency'],
    receivedOn: row.receivedOn,
    reference: row.reference,
    isVoided: row.voidedAt !== null,
    supersedesPaymentId: row.supersedesPaymentId,
  };
}

/**
 * `allocatedCharge = charge.extend({ appliedCents, status })` — reuses
 * `mapCharge` for the frozen half so an internal column added to `charge` can
 * never leak here just because it exists on the row. `status` is NEVER a
 * stored column — `chargeStatusFor` (the contract's own rule) computes it fresh
 * from `today`, which must be `localToday(property.timezone)`, never the
 * server's clock.
 */
export function mapAllocatedCharge(row: AllocatedChargeRow, today: IsoDate): AllocatedCharge {
  return {
    ...mapCharge(row),
    appliedCents: row.appliedCents,
    status: chargeStatusFor({
      amountCents: row.amountCents,
      appliedCents: row.appliedCents,
      dueDate: row.dueDate,
      isVoided: row.voidedAt !== null,
      today,
    }),
  };
}

/**
 * A discriminated union, not a flattened row (ledger.ts's own contract
 * comment). `appliedCents` (FIFO by due date) and `runningBalanceCents`
 * (chronological by effective date) do NOT agree row-by-row — `repo/ledger.ts`'s
 * `buildRunningLedger` computes the latter over the SAME allocated rows this
 * function renders, never a second allocation.
 */
export function mapLedgerEntry(entry: RawLedgerEntry, today: IsoDate): LedgerEntry {
  if (entry.kind === 'charge') {
    return {
      kind: 'charge',
      leaseId: entry.leaseId,
      effectiveDate: entry.effectiveDate,
      runningBalanceCents: entry.runningBalanceCents,
      charge: mapAllocatedCharge(entry.charge, today),
    };
  }
  return {
    kind: 'payment',
    leaseId: entry.leaseId,
    effectiveDate: entry.effectiveDate,
    runningBalanceCents: entry.runningBalanceCents,
    payment: mapPayment(entry.payment),
  };
}

export function mapLedgerLease(row: LedgerLeaseRow): LedgerLease {
  return {
    leaseId: row.leaseId,
    startDate: row.startDate,
    endDate: row.endDate,
    isCurrent: row.isCurrent,
  };
}

/**
 * The five-number identity — `balanceCents === outstandingCents - creditCents`
 * — is asserted in `repo/ledger.integration.test.ts`, over every allocation
 * fixture; this is purely a reshape of numbers `buildChainBalance` already
 * computed.
 */
export function mapChainBalance(row: ChainBalanceResult): ChainBalance {
  return {
    chainId: row.chainId,
    currency: row.currency as ChainBalance['currency'],
    asOfDate: row.asOfDate,
    chargedCents: row.chargedCents,
    paidCents: row.paidCents,
    outstandingCents: row.outstandingCents,
    creditCents: row.creditCents,
    balanceCents: row.balanceCents,
    arrearsCents: row.arrearsCents,
    depositOutstandingCents: row.depositOutstandingCents,
    rentOutstandingCents: row.rentOutstandingCents,
    oldestOverdueDueDate: row.oldestOverdueDueDate,
  };
}

/** No `creditCents`, no signed balance (§5.3) — a credit belongs to the
 *  tenancy, not to one of its leases. */
export function mapLeaseBalanceSlice(row: LeaseBalanceSliceResult): LeaseBalanceSlice {
  return {
    leaseId: row.leaseId,
    outstandingCents: row.outstandingCents,
    arrearsCents: row.arrearsCents,
    depositOutstandingCents: row.depositOutstandingCents,
    rentOutstandingCents: row.rentOutstandingCents,
  };
}

export function mapLeaseBalanceResponse(data: LeaseAndChainBalance): LeaseBalanceResponse {
  return {
    lease: mapLeaseBalanceSlice(data.lease),
    chain: mapChainBalance(data.chain),
  };
}

export function mapArrearsRow(row: ArrearsChainRow): ArrearsRow {
  return {
    chainId: row.chainId,
    leaseId: row.leaseId,
    propertyId: row.propertyId,
    propertyName: row.propertyName,
    unitId: row.unitId,
    unitLabel: row.unitLabel,
    primaryTenantName: row.primaryTenantName,
    arrearsCents: row.arrearsCents,
    oldestOverdueDueDate: row.oldestOverdueDueDate,
    daysLate: row.daysLate,
    isCurrent: row.isCurrent,
  };
}

/**
 * Grouped by currency at the TOP level (§6.2) — there is no shape here in which
 * a client could accidentally sum across currencies, because no array ever
 * contains two of them.
 */
export function mapArrearsResponse(
  rows: readonly ArrearsChainRow[],
  truncated: boolean,
  asOfDate: IsoDate,
): ArrearsResponse {
  const byCurrency = new Map<string, { chainCount: number; totalArrearsCents: number; rows: ArrearsRow[] }>();
  for (const row of rows) {
    const group = byCurrency.get(row.currency) ?? { chainCount: 0, totalArrearsCents: 0, rows: [] };
    group.chainCount += 1;
    group.totalArrearsCents += row.arrearsCents;
    group.rows.push(mapArrearsRow(row));
    byCurrency.set(row.currency, group);
  }

  const groups: ArrearsGroup[] = [...byCurrency.entries()].map(([currency, g]) => ({
    currency: currency as ArrearsGroup['currency'],
    chainCount: g.chainCount,
    totalArrearsCents: g.totalArrearsCents,
    rows: g.rows,
  }));

  return { asOfDate, groups, truncated };
}

export function mapPortalBalance(data: PortalBalanceResult): PortalBalance {
  return {
    leaseId: data.leaseId,
    currency: data.currency as PortalBalance['currency'],
    asOfDate: data.asOfDate,
    outstandingCents: data.outstandingCents,
    overdueCents: data.overdueCents,
    depositOutstandingCents: data.depositOutstandingCents,
    creditCents: data.creditCents,
    nextDueDate: data.nextDueDate,
    nextDueAmountCents: data.nextDueAmountCents,
  };
}
