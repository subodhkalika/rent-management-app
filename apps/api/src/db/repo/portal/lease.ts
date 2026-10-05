import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../index.js';
import { lease, leaseTenant, unit, property, organization, tenant } from '../../schema.js';
import type { TenantScope } from '../../../types.js';

/**
 * Tenant-facing lease reads. Every exported query-building function here takes
 * `scope: TenantScope` first and its body references BOTH `lease.orgId` and
 * `leaseTenant.tenantId` — a PAIR filter, not org alone. §7's dangerous row is a
 * tenant reaching their next-door neighbour's lease: same org, different tenant.
 * An org-only filter would return it; the pair filter (one `and()` clause per
 * `scope.pairs` entry, OR'd together) cannot.
 *
 * `portal-tenancy.guard.test.ts` enforces this statically. The pair-building
 * `and(eq(lease.orgId, p.orgId), eq(leaseTenant.tenantId, p.tenantId))` is written
 * out in full inside EACH exported query builder below, rather than factored into
 * one shared unexported helper — a shared helper's call site would not, itself,
 * contain the literal `orgId` / `tenantId` tokens the guard greps for, which would
 * make the guard pass vacuously on exactly the function it exists to check.
 */

export interface PortalLeaseRow {
  id: string;
  orgId: string;
  landlordName: string;
  status: (typeof lease.$inferSelect)['status'];
  unitLabel: string;
  propertyName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  propertyTimezone: string;
  calendar: (typeof property.$inferSelect)['calendar'];
  startDate: string;
  endDate: string | null;
  moveOutDate: string | null;
  rentCents: number;
  currency: string;
  rentFrequency: (typeof lease.$inferSelect)['rentFrequency'];
  billingDay: number;
  depositCents: number;
  moveOutBillingPolicy: (typeof property.$inferSelect)['moveOutBillingPolicy'];
  /** NULL = current. Non-null = former — §5.6: a removed tenant still reads
   *  everything on the lease, read-only, forever. */
  removedOn: string | null;
}

/** Column map shared by every row shape below. Pure data shape, not a filter — safe
 *  to share, unlike the pair-filter construction (see the module comment above). */
function portalLeaseColumns() {
  return {
    id: lease.id,
    orgId: lease.orgId,
    landlordName: organization.name,
    status: lease.status,
    unitLabel: unit.label,
    propertyName: property.name,
    addressLine1: property.addressLine1,
    addressLine2: property.addressLine2,
    city: property.city,
    region: property.region,
    postalCode: property.postalCode,
    country: property.country,
    propertyTimezone: property.timezone,
    calendar: property.calendar,
    startDate: lease.startDate,
    endDate: lease.endDate,
    moveOutDate: lease.moveOutDate,
    rentCents: lease.rentCents,
    currency: lease.currency,
    rentFrequency: lease.rentFrequency,
    billingDay: lease.billingDay,
    depositCents: lease.depositCents,
    moveOutBillingPolicy: property.moveOutBillingPolicy,
    removedOn: leaseTenant.removedOn,
  };
}

/**
 * All orgs the caller is a tenant in (§4.2 — unpaginated by design). One row per
 * (lease, caller's own tenant identity on it).
 */
export function listLeasesQuery(scope: TenantScope, db: Database) {
  const pairClauses = scope.pairs.map((p) => and(eq(lease.orgId, p.orgId), eq(leaseTenant.tenantId, p.tenantId)));

  return db
    .select(portalLeaseColumns())
    .from(lease)
    .innerJoin(leaseTenant, eq(leaseTenant.leaseId, lease.id))
    .innerJoin(unit, eq(unit.id, lease.unitId))
    .innerJoin(property, eq(property.id, unit.propertyId))
    .innerJoin(organization, eq(organization.id, lease.orgId))
    .where(and(isNull(lease.deletedAt), pairClauses.length > 0 ? or(...pairClauses) : sql`false`))
    .orderBy(asc(lease.startDate));
}

export async function listLeases(scope: TenantScope, db: Database): Promise<PortalLeaseRow[]> {
  return listLeasesQuery(scope, db);
}

export interface PortalCoTenantRow {
  firstName: string;
  lastName: string;
  isPrimary: boolean;
  isCurrent: boolean;
}

/**
 * Every OTHER tenant ever on `leaseId` (including former ones — §5.6), excluding
 * `callerTenantId` itself. `orgId` is resolved from `scope` via `callerTenantId`,
 * never trusted from any other input.
 */
export function listCoTenantsQuery(scope: TenantScope, db: Database, leaseId: string, callerTenantId: string) {
  const pair = scope.pairs.find((p) => p.tenantId === callerTenantId);
  const orgId = pair?.orgId ?? '';

  return db
    .select({
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      isPrimary: leaseTenant.isPrimary,
      removedOn: leaseTenant.removedOn,
    })
    .from(leaseTenant)
    .innerJoin(tenant, eq(tenant.id, leaseTenant.tenantId))
    .where(
      and(
        eq(leaseTenant.orgId, orgId),
        eq(leaseTenant.leaseId, leaseId),
        ne(leaseTenant.tenantId, callerTenantId),
      ),
    );
}

export async function listCoTenants(
  scope: TenantScope,
  db: Database,
  leaseId: string,
  callerTenantId: string,
): Promise<PortalCoTenantRow[]> {
  const rows = await listCoTenantsQuery(scope, db, leaseId, callerTenantId);
  return rows.map((r) => ({
    firstName: r.firstName,
    lastName: r.lastName,
    isPrimary: r.isPrimary,
    isCurrent: r.removedOn === null,
  }));
}

export interface PortalLeaseDetailRow extends PortalLeaseRow {
  ledgerStartDate: string;
  coTenants: PortalCoTenantRow[];
}

/**
 * §7's dangerous row, resolved: filters `lease.id = leaseId` AND
 * `(lease.orgId, leaseTenant.tenantId) IN scope.pairs`. Zero rows for a lease
 * belonging to another org, OR the caller's own org but someone else's tenancy on
 * it (the next-door-neighbour case) — both read identically as "zero rows", which
 * the route turns into 404, never 403.
 */
export function resolveLeaseQuery(scope: TenantScope, db: Database, leaseId: string) {
  const pairClauses = scope.pairs.map((p) => and(eq(lease.orgId, p.orgId), eq(leaseTenant.tenantId, p.tenantId)));

  return db
    .select({
      ...portalLeaseColumns(),
      ledgerStartDate: lease.ledgerStartDate,
      callerTenantId: leaseTenant.tenantId,
    })
    .from(lease)
    .innerJoin(leaseTenant, eq(leaseTenant.leaseId, lease.id))
    .innerJoin(unit, eq(unit.id, lease.unitId))
    .innerJoin(property, eq(property.id, unit.propertyId))
    .innerJoin(organization, eq(organization.id, lease.orgId))
    .where(
      and(eq(lease.id, leaseId), isNull(lease.deletedAt), pairClauses.length > 0 ? or(...pairClauses) : sql`false`),
    )
    .limit(1);
}

export async function resolveLease(
  scope: TenantScope,
  db: Database,
  leaseId: string,
): Promise<PortalLeaseDetailRow | null> {
  const [row] = await resolveLeaseQuery(scope, db, leaseId);
  if (!row) return null;

  const { callerTenantId, ...rest } = row;
  const coTenants = await listCoTenants(scope, db, leaseId, callerTenantId);
  return { ...rest, coTenants };
}

/**
 * Adds `removed_on IS NULL AND lease.status = 'active'` on top of `resolveLease`'s
 * filter. Named and exported now, per PLAN-PHASE2.md §5.6, so Phase 5's first
 * write-capable portal route (raise a maintenance request) uses the correct
 * resolver instead of inventing a filter at the call site. Nothing in Phase 2
 * calls this — a removed tenant reads, a removed tenant does not write.
 */
export function resolveActiveLeaseQuery(scope: TenantScope, db: Database, leaseId: string) {
  const pairClauses = scope.pairs.map((p) => and(eq(lease.orgId, p.orgId), eq(leaseTenant.tenantId, p.tenantId)));

  return db
    .select({ ...portalLeaseColumns(), ledgerStartDate: lease.ledgerStartDate })
    .from(lease)
    .innerJoin(leaseTenant, eq(leaseTenant.leaseId, lease.id))
    .innerJoin(unit, eq(unit.id, lease.unitId))
    .innerJoin(property, eq(property.id, unit.propertyId))
    .innerJoin(organization, eq(organization.id, lease.orgId))
    .where(
      and(
        eq(lease.id, leaseId),
        eq(lease.status, 'active'),
        isNull(lease.deletedAt),
        isNull(leaseTenant.removedOn),
        pairClauses.length > 0 ? or(...pairClauses) : sql`false`,
      ),
    )
    .limit(1);
}

export async function resolveActiveLease(
  scope: TenantScope,
  db: Database,
  leaseId: string,
): Promise<(PortalLeaseRow & { ledgerStartDate: string }) | null> {
  const [row] = await resolveActiveLeaseQuery(scope, db, leaseId);
  return row ?? null;
}
