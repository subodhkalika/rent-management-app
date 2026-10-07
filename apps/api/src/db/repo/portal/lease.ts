import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../index.js';
import { lease, leaseTenant, unit, property, organization, tenant } from '../../schema.js';
import type { TenantScope } from '../../../types.js';
import { listRentStepsQuery, type RentStepRow } from '../lease.js';

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
  // The escalation CLAUSE — what was agreed. Documentation only; the actual
  // ladder the tenant is charged is `rentSteps`, on the detail row only (the
  // escalation plan §4.7). Mapped via `escalationFromRow` — same function the
  // landlord side uses, since these are the SAME `lease` columns.
  escalationMode: (typeof lease.$inferSelect)['escalationMode'];
  escalationRateBps: number | null;
  escalationIntervalYears: number | null;
  escalationCompounding: (typeof lease.$inferSelect)['escalationCompounding'];
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
    escalationMode: lease.escalationMode,
    escalationRateBps: lease.escalationRateBps,
    escalationIntervalYears: lease.escalationIntervalYears,
    escalationCompounding: lease.escalationCompounding,
    removedOn: leaseTenant.removedOn,
  };
}

/**
 * All orgs the caller is a tenant in (§4.2 — unpaginated by design). One row per
 * LEASE — never two.
 *
 * `lease_tenant_live_uq` is deliberately partial on `removed_on IS NULL` (§3.4),
 * so a tenant who left and came back has TWO `lease_tenant` rows for the same
 * (lease, tenant): one historical (`removed_on` set) and one live. Both satisfy
 * the pair filter below (it matches on `tenantId` alone, not on `removed_on`), so
 * an unscoped `INNER JOIN` returns the SAME lease twice — one "former", one
 * "current". `selectDistinctOn` collapses that to one row per `lease.id`,
 * ordered so the row with `removed_on IS NULL` (current) wins whenever one
 * exists — a current tenant must never be shown as former just because Postgres
 * happened to return the other row. Same reasoning `countActiveLeasesForTenantQuery`
 * uses `count(distinct lease.id)` for.
 *
 * Ordered by `lease.id` (not `startDate`) as a consequence: Postgres requires
 * `DISTINCT ON`'s leading `ORDER BY` columns to match its own column list, so the
 * tiebreak above has to come second. `lease.id` is UUIDv7 — time-ordered by
 * creation — which is a perfectly reasonable order for a short, unpaginated list.
 */
export function listLeasesQuery(scope: TenantScope, db: Database) {
  const pairClauses = scope.pairs.map((p) => and(eq(lease.orgId, p.orgId), eq(leaseTenant.tenantId, p.tenantId)));

  return db
    .selectDistinctOn([lease.id], portalLeaseColumns())
    .from(lease)
    .innerJoin(leaseTenant, eq(leaseTenant.leaseId, lease.id))
    .innerJoin(unit, eq(unit.id, lease.unitId))
    .innerJoin(property, eq(property.id, unit.propertyId))
    .innerJoin(organization, eq(organization.id, lease.orgId))
    .where(and(isNull(lease.deletedAt), pairClauses.length > 0 ? or(...pairClauses) : sql`false`))
    .orderBy(asc(lease.id), sql`${leaseTenant.removedOn} asc nulls first`);
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
  /** Ascending by `effectiveFrom`. The real numbers they will pay — see
   *  `portalRentStep` in `packages/contract/src/portal.ts`. */
  rentSteps: RentStepRow[];
}

/**
 * §7's dangerous row, resolved: filters `lease.id = leaseId` AND
 * `(lease.orgId, leaseTenant.tenantId) IN scope.pairs`. Zero rows for a lease
 * belonging to another org, OR the caller's own org but someone else's tenancy on
 * it (the next-door-neighbour case) — both read identically as "zero rows", which
 * the route turns into 404, never 403.
 *
 * Same left-and-came-back duplicate as `listLeasesQuery` above can produce TWO
 * matching rows here too (former + current). `.limit(1)` with no `ORDER BY` would
 * then return whichever Postgres happens to pick — `removedOn`, and therefore
 * `yourRole` and the "you were removed on" banner, would be nondeterministic, and
 * a CURRENT tenant could be shown as former. Ordered so `removed_on IS NULL`
 * (current) wins whenever one exists.
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
    .orderBy(sql`${leaseTenant.removedOn} asc nulls first`)
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
  // `row.orgId` is TRUSTED here — it came from the pair-filtered resolve above,
  // never from request input — so the landlord side's own query builder
  // (already `WHERE org_id = $1 AND lease_id = $2`) is reused rather than
  // duplicated. §4.6 of the escalation plan: the portal ladder is the real
  // ladder, not a re-derivation of it.
  const [coTenants, rentStepRows] = await Promise.all([
    listCoTenants(scope, db, leaseId, callerTenantId),
    listRentStepsQuery(row.orgId, db, leaseId),
  ]);
  return { ...rest, coTenants, rentSteps: rentStepRows };
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
