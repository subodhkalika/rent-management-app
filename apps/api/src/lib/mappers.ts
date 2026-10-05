import type {
  Property,
  Unit,
  Tenant,
  PortalAccess,
  PortalProfile,
  LeaseSummary,
  LeaseDetail,
  LeaseTenantSummary,
  PortalLease,
  PortalLeaseDetail,
} from '@rms/contract';
import type { PropertyRow } from '../db/repo/property.js';
import type { UnitRow } from '../db/repo/unit.js';
import type { TenantRow } from '../db/repo/tenant.js';
import type { PortalProfileRow } from '../db/repo/portal/profile.js';
import type { LeaseRow, LeaseDetailRow, LeaseTenantRow } from '../db/repo/lease.js';
import type { PortalLeaseRow, PortalLeaseDetailRow } from '../db/repo/portal/lease.js';

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
    tenantCount: row.tenantCount,
    primaryTenantName: row.primaryTenantName,
    renewedFromLeaseId: row.renewedFromLeaseId,
    endReason: row.endReason as LeaseSummary['endReason'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
  };
}
