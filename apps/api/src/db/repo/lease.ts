import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  uuidv7,
  addDays,
  compareIsoDate,
  localToday,
  statusForEndReason,
  validateBillingTerms,
  type CreateLeaseBody,
  type UpdateLeaseBody,
  type EndLeaseBody,
  type RenewLeaseBody,
  type AddLeaseTenantBody,
  type RemoveLeaseTenantBody,
  type LeaseBillingTerms,
} from '@rms/contract';
import type { Database } from '../index.js';
import { lease, leaseTenant, unit, property, tenant } from '../schema.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { decodeCursor } from '../../lib/pagination.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import * as unitRepo from './unit.js';
import * as propertyRepo from './property.js';

/**
 * Message fired by BOTH the pre-check in `activateLease` (the nice message) and the
 * `isUniqueViolation` catch around the UPDATE (the authority, for the race) — see
 * schema.ts's `lease_unit_active_uq` comment and PLAN-PHASE2.md §3.3.
 */
const UNIT_ACTIVE_CONFLICT_MESSAGE =
  'This unit already has an active lease. End the current lease before starting a new one.';
const NO_TENANTS_MESSAGE = 'Add at least one tenant and mark one as primary before activating.';

type LeaseStatusValue = (typeof lease.$inferSelect)['status'];

/* ======================================================================== *
 * shared selection — everything `leaseSummary` (packages/contract/src/lease.ts)
 * needs, joined from lease -> unit -> property (LIVE read of moveOutBillingPolicy
 * and calendar — Amendment A.3, no column on `lease` for either) plus two
 * aggregate subqueries for the roster.
 * ======================================================================== */

export interface LeaseRow {
  id: string;
  chainId: string;
  status: LeaseStatusValue;
  unitId: string;
  unitLabel: string;
  propertyId: string;
  propertyName: string;
  propertyTimezone: string;
  calendar: (typeof property.$inferSelect)['calendar'];
  moveOutBillingPolicy: (typeof property.$inferSelect)['moveOutBillingPolicy'];
  startDate: string;
  endDate: string | null;
  moveOutDate: string | null;
  rentCents: number;
  currency: string;
  rentFrequency: (typeof lease.$inferSelect)['rentFrequency'];
  billingDay: number;
  depositCents: number;
  openingBalanceCents: number;
  ledgerStartDate: string;
  tenantCount: number;
  primaryTenantName: string | null;
  renewedFromLeaseId: string | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Live (removed_on IS NULL) roster count per lease, scoped to this org. */
function tenantCountSubquery(orgId: string, db: Database) {
  return db
    .select({
      leaseId: leaseTenant.leaseId,
      count: sql<number>`count(*)`.mapWith(Number).as('count'),
    })
    .from(leaseTenant)
    .where(and(eq(leaseTenant.orgId, orgId), isNull(leaseTenant.removedOn)))
    .groupBy(leaseTenant.leaseId)
    .as('tenant_count');
}

/** The live primary tenant's display name per lease. At most one row per lease by
 *  construction (`lease_tenant_primary_uq`). */
function primaryTenantSubquery(orgId: string, db: Database) {
  return db
    .select({
      leaseId: leaseTenant.leaseId,
      name: sql<string>`${tenant.firstName} || ' ' || ${tenant.lastName}`.as('name'),
    })
    .from(leaseTenant)
    .innerJoin(tenant, eq(tenant.id, leaseTenant.tenantId))
    .where(and(eq(leaseTenant.orgId, orgId), eq(leaseTenant.isPrimary, true), isNull(leaseTenant.removedOn)))
    .as('primary_tenant');
}

/** The column map shared by every lease read below. Split out so the aggregate
 *  math (tenantCount / primaryTenantName) is defined exactly once. */
function leaseColumns(tenantCount: ReturnType<typeof tenantCountSubquery>, primaryTenant: ReturnType<typeof primaryTenantSubquery>) {
  return {
    id: lease.id,
    chainId: lease.chainId,
    status: lease.status,
    unitId: lease.unitId,
    unitLabel: unit.label,
    propertyId: property.id,
    propertyName: property.name,
    propertyTimezone: property.timezone,
    calendar: property.calendar,
    moveOutBillingPolicy: property.moveOutBillingPolicy,
    startDate: lease.startDate,
    endDate: lease.endDate,
    moveOutDate: lease.moveOutDate,
    rentCents: lease.rentCents,
    currency: lease.currency,
    rentFrequency: lease.rentFrequency,
    billingDay: lease.billingDay,
    depositCents: lease.depositCents,
    openingBalanceCents: lease.openingBalanceCents,
    ledgerStartDate: lease.ledgerStartDate,
    tenantCount: sql<number>`coalesce(${tenantCount.count}, 0)`.mapWith(Number),
    primaryTenantName: primaryTenant.name,
    renewedFromLeaseId: lease.renewedFromLeaseId,
    endReason: lease.endReason,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
  };
}

export function listLeasesQuery(
  orgId: string,
  db: Database,
  opts: {
    limit: number;
    cursor?: string;
    status?: LeaseStatusValue;
    unitId?: string;
    propertyId?: string;
    tenantId?: string;
  },
) {
  const tc = tenantCountSubquery(orgId, db);
  const pt = primaryTenantSubquery(orgId, db);

  const conditions = [eq(lease.orgId, orgId), isNull(lease.deletedAt)];
  if (opts.cursor) conditions.push(gt(lease.id, decodeCursor(opts.cursor)));
  if (opts.status) conditions.push(eq(lease.status, opts.status));
  if (opts.unitId) conditions.push(eq(lease.unitId, opts.unitId));
  if (opts.propertyId) conditions.push(eq(unit.propertyId, opts.propertyId));
  if (opts.tenantId) {
    conditions.push(
      inArray(
        lease.id,
        db
          .select({ id: leaseTenant.leaseId })
          .from(leaseTenant)
          .where(and(eq(leaseTenant.orgId, orgId), eq(leaseTenant.tenantId, opts.tenantId))),
      ),
    );
  }

  return db
    .select(leaseColumns(tc, pt))
    .from(lease)
    // Scoped by orgId too, not just the FK — belt-and-suspenders, same reasoning
    // as property.ts's unit join.
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
    .leftJoin(tc, eq(tc.leaseId, lease.id))
    .leftJoin(pt, eq(pt.leaseId, lease.id))
    .where(and(...conditions))
    .orderBy(asc(lease.id))
    .limit(opts.limit + 1);
}

export async function listLeases(
  orgId: string,
  db: Database,
  opts: {
    limit: number;
    cursor?: string;
    status?: LeaseStatusValue;
    unitId?: string;
    propertyId?: string;
    tenantId?: string;
  },
): Promise<{ rows: LeaseRow[]; hasMore: boolean }> {
  const rows = await listLeasesQuery(orgId, db, opts);
  const hasMore = rows.length > opts.limit;
  return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
}

export function getLeaseQuery(orgId: string, db: Database, id: string) {
  const tc = tenantCountSubquery(orgId, db);
  const pt = primaryTenantSubquery(orgId, db);

  return db
    .select(leaseColumns(tc, pt))
    .from(lease)
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
    .leftJoin(tc, eq(tc.leaseId, lease.id))
    .leftJoin(pt, eq(pt.leaseId, lease.id))
    .where(and(eq(lease.orgId, orgId), eq(lease.id, id), isNull(lease.deletedAt)))
    .limit(1);
}

export async function getLease(orgId: string, db: Database, id: string): Promise<LeaseRow | null> {
  const [row] = await getLeaseQuery(orgId, db, id);
  return row ?? null;
}

/* ======================================================================== *
 * detail — tenants array, chain, notes, unit status, property address
 * ======================================================================== */

export interface LeaseTenantRow {
  tenantId: string;
  firstName: string;
  lastName: string;
  isPrimary: boolean;
  addedOn: string;
  removedOn: string | null;
}

export function listLeaseTenantsQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select({
      tenantId: leaseTenant.tenantId,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      isPrimary: leaseTenant.isPrimary,
      addedOn: leaseTenant.addedOn,
      removedOn: leaseTenant.removedOn,
    })
    .from(leaseTenant)
    .innerJoin(tenant, and(eq(tenant.id, leaseTenant.tenantId), eq(tenant.orgId, orgId)))
    .where(and(eq(leaseTenant.orgId, orgId), eq(leaseTenant.leaseId, leaseId)))
    .orderBy(asc(leaseTenant.addedOn));
}

export async function listLeaseTenants(orgId: string, db: Database, leaseId: string): Promise<LeaseTenantRow[]> {
  return listLeaseTenantsQuery(orgId, db, leaseId);
}

export interface LeaseChainEntryRow {
  id: string;
  status: LeaseStatusValue;
  startDate: string;
  endDate: string | null;
  rentCents: number;
}

export function getChainQuery(orgId: string, db: Database, chainId: string) {
  return db
    .select({
      id: lease.id,
      status: lease.status,
      startDate: lease.startDate,
      endDate: lease.endDate,
      rentCents: lease.rentCents,
    })
    .from(lease)
    .where(and(eq(lease.orgId, orgId), eq(lease.chainId, chainId), isNull(lease.deletedAt)))
    .orderBy(asc(lease.startDate));
}

export async function getChain(orgId: string, db: Database, chainId: string): Promise<LeaseChainEntryRow[]> {
  return getChainQuery(orgId, db, chainId);
}

export interface LeaseDetailRow extends LeaseRow {
  notes: string | null;
  unitStatus: (typeof unit.$inferSelect)['status'];
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  tenants: LeaseTenantRow[];
  chain: LeaseChainEntryRow[];
}

export function getLeaseDetailQuery(orgId: string, db: Database, id: string) {
  const tc = tenantCountSubquery(orgId, db);
  const pt = primaryTenantSubquery(orgId, db);

  return db
    .select({
      ...leaseColumns(tc, pt),
      notes: lease.notes,
      unitStatus: unit.status,
      addressLine1: property.addressLine1,
      addressLine2: property.addressLine2,
      city: property.city,
      region: property.region,
      postalCode: property.postalCode,
      country: property.country,
    })
    .from(lease)
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
    .leftJoin(tc, eq(tc.leaseId, lease.id))
    .leftJoin(pt, eq(pt.leaseId, lease.id))
    .where(and(eq(lease.orgId, orgId), eq(lease.id, id), isNull(lease.deletedAt)))
    .limit(1);
}

export async function getLeaseDetail(orgId: string, db: Database, id: string): Promise<LeaseDetailRow | null> {
  const [row] = await getLeaseDetailQuery(orgId, db, id);
  if (!row) return null;

  const [tenants, chain] = await Promise.all([
    listLeaseTenants(orgId, db, id),
    getChain(orgId, db, row.chainId),
  ]);

  return { ...row, tenants, chain };
}

/* ======================================================================== *
 * the roster-insert cross-org guard — PLAN-PHASE2.md §7.1's named most-likely bug
 * ======================================================================== */

export function resolveTenantIdsQuery(orgId: string, db: Database, tenantIds: readonly string[]) {
  return db
    .select({ id: tenant.id })
    .from(tenant)
    .where(and(eq(tenant.orgId, orgId), inArray(tenant.id, [...tenantIds]), isNull(tenant.deletedAt)));
}

/**
 * Resolves `tenantIds` against THIS org only, discarding anything that does not
 * belong to it. The caller MUST compare the returned array's length against the
 * input's — a short result means at least one id was another org's tenant (or did
 * not exist at all), and the caller 404s rather than inserting a partial roster.
 *
 * This is the fix for the single most likely cross-org bug in this phase: a blind
 * multi-row INSERT built straight from the request body's `tenantIds` would write
 * landlord A's tenant onto landlord B's lease the moment B supplied A's UUID.
 */
export async function resolveTenantIds(orgId: string, db: Database, tenantIds: readonly string[]): Promise<string[]> {
  if (tenantIds.length === 0) return [];
  const rows = await resolveTenantIdsQuery(orgId, db, tenantIds);
  return rows.map((r) => r.id);
}

/* ======================================================================== *
 * blocking-lease counts for the three amended delete routes (§3.6)
 * ======================================================================== */

export function countActiveLeasesForUnitQuery(
  orgId: string,
  db: Database,
  unitId: string,
  excludeLeaseId?: string,
) {
  const conditions = [eq(lease.orgId, orgId), eq(lease.unitId, unitId), eq(lease.status, 'active')];
  if (excludeLeaseId) conditions.push(ne(lease.id, excludeLeaseId));
  return db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(lease)
    .where(and(...conditions));
}

export async function countActiveLeasesForUnit(
  orgId: string,
  db: Database,
  unitId: string,
  excludeLeaseId?: string,
): Promise<number> {
  const [row] = await countActiveLeasesForUnitQuery(orgId, db, unitId, excludeLeaseId);
  return row?.count ?? 0;
}

export function countActiveLeasesForTenantQuery(orgId: string, db: Database, tenantId: string) {
  return db
    .select({ count: sql<number>`count(distinct ${lease.id})`.mapWith(Number) })
    .from(lease)
    .innerJoin(leaseTenant, and(eq(leaseTenant.leaseId, lease.id), eq(leaseTenant.orgId, orgId)))
    .where(
      and(
        eq(lease.orgId, orgId),
        eq(lease.status, 'active'),
        eq(leaseTenant.tenantId, tenantId),
        isNull(leaseTenant.removedOn),
      ),
    );
}

export async function countActiveLeasesForTenant(orgId: string, db: Database, tenantId: string): Promise<number> {
  const [row] = await countActiveLeasesForTenantQuery(orgId, db, tenantId);
  return row?.count ?? 0;
}

export function countActiveLeasesForPropertyQuery(orgId: string, db: Database, propertyId: string) {
  return db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(lease)
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .where(and(eq(lease.orgId, orgId), eq(lease.status, 'active'), eq(unit.propertyId, propertyId)));
}

export async function countActiveLeasesForProperty(orgId: string, db: Database, propertyId: string): Promise<number> {
  const [row] = await countActiveLeasesForPropertyQuery(orgId, db, propertyId);
  return row?.count ?? 0;
}

/* ======================================================================== *
 * create — always draft (Decision #10)
 * ======================================================================== */

export function createLeaseQuery(
  orgId: string,
  db: Database,
  id: string,
  userId: string,
  unitId: string,
  currency: string,
  ledgerStartDate: string,
  data: CreateLeaseBody,
) {
  return db.insert(lease).values({
    id,
    orgId,
    unitId,
    chainId: id,
    renewedFromLeaseId: null,
    startDate: data.startDate,
    endDate: data.endDate ?? null,
    rentCents: data.rentCents,
    currency,
    rentFrequency: data.rentFrequency,
    billingDay: data.billingDay,
    depositCents: data.depositCents,
    openingBalanceCents: data.openingBalanceCents,
    ledgerStartDate,
    status: 'draft',
    notes: data.notes ?? null,
    createdByUserId: userId,
  });
}

export function insertLeaseTenantsQuery(
  orgId: string,
  db: Database,
  leaseId: string,
  tenantIds: readonly string[],
  primaryTenantId: string,
  addedOn: string,
) {
  return db.insert(leaseTenant).values(
    tenantIds.map((tenantId) => ({
      id: uuidv7(),
      orgId,
      leaseId,
      tenantId,
      isPrimary: tenantId === primaryTenantId,
      addedOn,
    })),
  );
}

export async function createLease(
  orgId: string,
  db: Database,
  userId: string,
  data: CreateLeaseBody,
): Promise<LeaseRow> {
  // getUnit already filters org_id, deleted_at IS NULL and liveProperties — §7.1's
  // "POST /v1/leases { unitId: A_unit } -> 404" case is covered for free.
  const unitRow = await unitRepo.getUnit(orgId, db, data.unitId);
  if (!unitRow) throw notFound('Unit');

  const propertyRow = await propertyRepo.getProperty(orgId, db, unitRow.propertyId);
  if (!propertyRow) throw notFound('Unit');

  // THE cross-org roster guard (§7.1) — never trust the body's tenantIds directly.
  const resolvedTenantIds = await resolveTenantIds(orgId, db, data.tenantIds);
  if (resolvedTenantIds.length !== data.tenantIds.length) throw notFound('Tenant');

  const ledgerStartDate = data.ledgerStartDate ?? data.startDate;

  // createLeaseBody's shared superRefine can only validate against a default
  // Gregorian calendar (it has no property to consult). This is the one place
  // that can re-validate against the lease's REAL calendar and move-out policy.
  const terms: LeaseBillingTerms = {
    frequency: data.rentFrequency,
    rentCents: data.rentCents,
    billingDay: data.billingDay,
    startDate: data.startDate,
    endDate: data.endDate ?? null,
    ledgerStartDate,
    moveOutDate: null,
    moveOutBillingPolicy: propertyRow.moveOutBillingPolicy,
    calendar: propertyRow.calendar,
  };
  const billingError = validateBillingTerms(terms);
  if (billingError) throw validationFailed({ _: [billingError] });

  const id = uuidv7();
  await createLeaseQuery(orgId, db, id, userId, data.unitId, unitRow.currency, ledgerStartDate, data);

  if (resolvedTenantIds.length > 0) {
    await insertLeaseTenantsQuery(orgId, db, id, resolvedTenantIds, data.primaryTenantId, data.startDate);
  }

  const created = await getLease(orgId, db, id);
  if (!created) throw new Error('Lease not found immediately after insert');
  return created;
}

/* ======================================================================== *
 * update — mutability depends on status (§4.1)
 * ======================================================================== */

/**
 * Pure: which field in `patch` is illegal for `status`, and the message naming the
 * right route — `/renew` for a term-defining field, `/end` for a shortened term,
 * a generic "left draft" message for `ledgerStartDate`/`openingBalanceCents`.
 * Returns `null` when the whole patch is legal for this status. Exported so a test
 * can exercise every §4.1 cell without a database.
 */
export function illegalUpdateField(
  status: LeaseStatusValue,
  patch: UpdateLeaseBody,
  current: { endDate: string | null },
): string | null {
  if (status === 'draft') return null;

  const RENEW_FIELDS = ['unitId', 'startDate', 'rentCents', 'rentFrequency'] as const;
  for (const f of RENEW_FIELDS) {
    if (patch[f] !== undefined) {
      return `${f} cannot be changed on a lease that has been active. Use /renew instead.`;
    }
  }

  const ALWAYS_IMMUTABLE = ['ledgerStartDate', 'openingBalanceCents'] as const;
  for (const f of ALWAYS_IMMUTABLE) {
    if (patch[f] !== undefined) {
      return `${f} cannot be changed once a lease has left draft.`;
    }
  }

  if (patch.endDate !== undefined && current.endDate !== null) {
    const shortened = patch.endDate === null || compareIsoDate(patch.endDate, current.endDate) < 0;
    if (shortened) {
      return 'Shortening endDate is ending the lease early. Use /end instead.';
    }
  }

  if (status === 'active') return null;

  // ended / terminated / cancelled: only notes and moveOutDate.
  const ALLOWED_TERMINAL = new Set(['notes', 'moveOutDate']);
  for (const key of Object.keys(patch) as (keyof UpdateLeaseBody)[]) {
    if (patch[key] === undefined) continue;
    if (!ALLOWED_TERMINAL.has(key)) {
      return `${key} cannot be changed once a lease has ended.`;
    }
  }
  return null;
}

export function updateLeaseQuery(
  orgId: string,
  db: Database,
  id: string,
  data: UpdateLeaseBody,
  currency?: string,
) {
  const patch: Partial<typeof lease.$inferInsert> = { updatedAt: new Date() };
  if (data.unitId !== undefined) patch.unitId = data.unitId;
  if (currency !== undefined) patch.currency = currency;
  if (data.startDate !== undefined) patch.startDate = data.startDate;
  if (data.endDate !== undefined) patch.endDate = data.endDate ?? null;
  if (data.rentCents !== undefined) patch.rentCents = data.rentCents;
  if (data.rentFrequency !== undefined) patch.rentFrequency = data.rentFrequency;
  if (data.billingDay !== undefined) patch.billingDay = data.billingDay;
  if (data.depositCents !== undefined) patch.depositCents = data.depositCents;
  if (data.ledgerStartDate !== undefined) patch.ledgerStartDate = data.ledgerStartDate;
  if (data.openingBalanceCents !== undefined) patch.openingBalanceCents = data.openingBalanceCents;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;
  if (data.moveOutDate !== undefined) patch.moveOutDate = data.moveOutDate ?? null;

  return db
    .update(lease)
    .set(patch)
    .where(and(eq(lease.orgId, orgId), eq(lease.id, id), isNull(lease.deletedAt)))
    .returning({ id: lease.id });
}

export async function updateLease(
  orgId: string,
  db: Database,
  id: string,
  data: UpdateLeaseBody,
): Promise<LeaseRow | null> {
  const current = await getLease(orgId, db, id);
  if (!current) return null;

  const illegal = illegalUpdateField(current.status, data, { endDate: current.endDate });
  if (illegal) throw conflict(illegal);

  const BILLING_FIELDS = ['startDate', 'endDate', 'rentFrequency', 'billingDay', 'ledgerStartDate', 'moveOutDate', 'rentCents'] as const;
  const touchesBilling = BILLING_FIELDS.some((f) => data[f] !== undefined);
  if (touchesBilling) {
    const terms: LeaseBillingTerms = {
      frequency: data.rentFrequency ?? current.rentFrequency,
      rentCents: data.rentCents ?? current.rentCents,
      billingDay: data.billingDay ?? current.billingDay,
      startDate: data.startDate ?? current.startDate,
      endDate: data.endDate !== undefined ? (data.endDate ?? null) : current.endDate,
      ledgerStartDate: data.ledgerStartDate ?? current.ledgerStartDate,
      moveOutDate: data.moveOutDate !== undefined ? (data.moveOutDate ?? null) : current.moveOutDate,
      moveOutBillingPolicy: current.moveOutBillingPolicy,
      calendar: current.calendar,
    };
    const billingError = validateBillingTerms(terms);
    if (billingError) throw validationFailed({ _: [billingError] });
  }

  let currency: string | undefined;
  if (data.unitId !== undefined && data.unitId !== current.unitId) {
    const unitRow = await unitRepo.getUnit(orgId, db, data.unitId);
    if (!unitRow) throw notFound('Unit');
    currency = unitRow.currency;
  }

  const result = await updateLeaseQuery(orgId, db, id, data, currency);
  if (result.length === 0) return null;
  return getLease(orgId, db, id);
}

/* ======================================================================== *
 * lifecycle transitions (§5)
 * ======================================================================== */

export async function activateLease(orgId: string, db: Database, id: string): Promise<LeaseRow | null> {
  const current = await getLease(orgId, db, id);
  if (!current) return null;

  if (current.status !== 'draft') throw conflict('Only a draft lease can be activated.');

  const unitRow = await unitRepo.getUnit(orgId, db, current.unitId);
  if (!unitRow) throw conflict('This unit no longer exists. Choose a different unit for this lease.');
  if (unitRow.status === 'unavailable') {
    throw conflict('This unit is marked unavailable. Change its status before activating a lease.');
  }

  const activeElsewhere = await countActiveLeasesForUnit(orgId, db, current.unitId, id);
  if (activeElsewhere > 0) throw conflict(UNIT_ACTIVE_CONFLICT_MESSAGE);

  const roster = await listLeaseTenants(orgId, db, id);
  const live = roster.filter((t) => t.removedOn === null);
  const primaries = live.filter((t) => t.isPrimary);
  if (live.length === 0 || primaries.length !== 1) throw conflict(NO_TENANTS_MESSAGE);

  try {
    const result = await db
      .update(lease)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(lease.orgId, orgId), eq(lease.id, id), eq(lease.status, 'draft')))
      .returning({ id: lease.id });
    if (result.length === 0) return null;
  } catch (err) {
    // The race: two concurrent activates for the same unit. The pre-check above
    // is the nice message; this catch is the authority.
    if (isUniqueViolation(err)) throw conflict(UNIT_ACTIVE_CONFLICT_MESSAGE);
    throw err;
  }

  // §5.4: lease row, THEN unit.status — a torn failure here leaves an active lease
  // on a unit still marked vacant, which is visible and the lease is the system of
  // record.
  await unitRepo.updateUnit(orgId, db, current.unitId, { status: 'occupied' });

  return getLease(orgId, db, id);
}

export async function cancelLease(orgId: string, db: Database, id: string): Promise<LeaseRow | null> {
  const current = await getLease(orgId, db, id);
  if (!current) return null;
  if (current.status !== 'draft') throw conflict('Only a draft lease can be cancelled.');

  const result = await db
    .update(lease)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(lease.orgId, orgId), eq(lease.id, id), eq(lease.status, 'draft')))
    .returning({ id: lease.id });
  if (result.length === 0) return null;
  return getLease(orgId, db, id);
}

export async function endLease(
  orgId: string,
  db: Database,
  id: string,
  data: EndLeaseBody,
): Promise<LeaseRow | null> {
  const current = await getLease(orgId, db, id);
  if (!current) return null;

  if (current.status === 'draft') throw conflict('Activate the lease first, or cancel it.');
  if (current.status !== 'active') throw conflict('This lease has already ended.');

  if (compareIsoDate(data.endDate, current.startDate) < 0) {
    throw conflict('endDate cannot be before the lease started.');
  }
  if (compareIsoDate(data.endDate, current.ledgerStartDate) < 0) {
    throw conflict('endDate cannot be before the ledger start date.');
  }

  const status = statusForEndReason(data.reason);

  const result = await db
    .update(lease)
    .set({
      status,
      endDate: data.endDate,
      moveOutDate: data.moveOutDate !== undefined ? (data.moveOutDate ?? null) : current.moveOutDate,
      endReason: data.reason,
      endNote: data.note ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(lease.orgId, orgId), eq(lease.id, id), eq(lease.status, 'active')))
    .returning({ id: lease.id });
  if (result.length === 0) return null;

  // §5.4: lease row, THEN unit.status — only to vacant if no other active lease
  // remains on the unit AND the unit currently reads occupied.
  const stillActive = await countActiveLeasesForUnit(orgId, db, current.unitId);
  if (stillActive === 0) {
    const unitRow = await unitRepo.getUnit(orgId, db, current.unitId);
    if (unitRow && unitRow.status === 'occupied') {
      await unitRepo.updateUnit(orgId, db, current.unitId, { status: 'vacant' });
    }
  }

  return getLease(orgId, db, id);
}

export async function renewLease(
  orgId: string,
  db: Database,
  userId: string,
  predecessorId: string,
  data: RenewLeaseBody,
): Promise<LeaseRow | null> {
  const predecessor = await getLease(orgId, db, predecessorId);
  if (!predecessor) return null;

  if (predecessor.status !== 'active' && predecessor.status !== 'ended') {
    throw conflict('Only an active or ended lease can be renewed.');
  }

  if (predecessor.status === 'active') {
    if (compareIsoDate(data.startDate, predecessor.startDate) <= 0) {
      throw conflict("The renewal's startDate must be after the current lease's startDate.");
    }
  } else if (predecessor.endDate !== null && compareIsoDate(data.startDate, predecessor.endDate) <= 0) {
    // ended -> new row: a gap is allowed, but never an overlap (§5.2).
    throw conflict("The renewal's startDate must be after the predecessor's endDate.");
  }

  const predecessorRoster = await listLeaseTenants(orgId, db, predecessorId);
  const liveRoster = predecessorRoster.filter((t) => t.removedOn === null);

  const carryTenantIdsRaw = data.carryTenantIds ?? liveRoster.map((t) => t.tenantId);
  // Resolved against THIS org even though these are "carried" ids — a client
  // could still supply an arbitrary array (§7.1's guard applies here too).
  const resolvedTenantIds = await resolveTenantIds(orgId, db, carryTenantIdsRaw);
  if (resolvedTenantIds.length !== carryTenantIdsRaw.length) throw notFound('Tenant');

  const predecessorPrimary = liveRoster.find((t) => t.isPrimary);
  const primaryTenantId = data.primaryTenantId ?? predecessorPrimary?.tenantId;
  if (primaryTenantId === undefined || !resolvedTenantIds.includes(primaryTenantId)) {
    throw validationFailed({ primaryTenantId: ['primaryTenantId must be one of the renewed roster'] });
  }

  const rentFrequency = data.rentFrequency ?? predecessor.rentFrequency;
  const billingDay = data.billingDay ?? predecessor.billingDay;
  const depositCents = data.depositCents ?? predecessor.depositCents;

  const terms: LeaseBillingTerms = {
    frequency: rentFrequency,
    rentCents: data.rentCents,
    billingDay,
    startDate: data.startDate,
    endDate: data.endDate ?? null,
    ledgerStartDate: data.startDate,
    moveOutDate: null,
    moveOutBillingPolicy: predecessor.moveOutBillingPolicy,
    calendar: predecessor.calendar,
  };
  const billingError = validateBillingTerms(terms);
  if (billingError) throw validationFailed({ _: [billingError] });

  // §5.4: end the predecessor FIRST, then insert the successor. Inserting first
  // would hit lease_unit_active_uq and 500 on the legitimate path.
  if (predecessor.status === 'active') {
    const predecessorEnd = addDays(data.startDate, -1);
    await db
      .update(lease)
      .set({ status: 'ended', endDate: predecessorEnd, endReason: 'renewed', updatedAt: new Date() })
      .where(and(eq(lease.orgId, orgId), eq(lease.id, predecessorId), eq(lease.status, 'active')));
  }

  const id = uuidv7();
  try {
    await db.insert(lease).values({
      id,
      orgId,
      unitId: predecessor.unitId,
      chainId: predecessor.chainId,
      renewedFromLeaseId: predecessor.id,
      startDate: data.startDate,
      endDate: data.endDate ?? null,
      rentCents: data.rentCents,
      currency: predecessor.currency,
      rentFrequency,
      billingDay,
      depositCents,
      openingBalanceCents: 0,
      ledgerStartDate: data.startDate,
      status: 'active',
      notes: data.notes ?? null,
      createdByUserId: userId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(UNIT_ACTIVE_CONFLICT_MESSAGE);
    throw err;
  }

  if (resolvedTenantIds.length > 0) {
    await insertLeaseTenantsQuery(orgId, db, id, resolvedTenantIds, primaryTenantId, data.startDate);
  }

  // A future-dated renewal is created `active` directly (§5.3) — the unit is
  // genuinely booked, so it reads `occupied` immediately.
  await unitRepo.updateUnit(orgId, db, predecessor.unitId, { status: 'occupied' });

  const created = await getLease(orgId, db, id);
  if (!created) throw new Error('Lease not found immediately after insert');
  return created;
}

/* ======================================================================== *
 * delete — draft/cancelled only (§5.2)
 * ======================================================================== */

export function hardDeleteLeaseQuery(orgId: string, db: Database, id: string) {
  return db
    .update(lease)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(lease.orgId, orgId),
        eq(lease.id, id),
        isNull(lease.deletedAt),
        inArray(lease.status, ['draft', 'cancelled']),
      ),
    )
    .returning({ id: lease.id });
}

/**
 * Named `hardDeleteLease` (PLAN-PHASE2.md §8.1) to mark it as the terminal "gone"
 * operation distinct from every other lifecycle transition — not a literal SQL
 * DELETE. Soft-deletes (sets `deletedAt`, excluded from every other query here on)
 * the same way every other table in this schema is deleted; a draft/cancelled
 * lease never had charges or payments written against it (no other table
 * references it yet), so nothing is lost by keeping the row.
 *
 * Returns `'blocked'` rather than throwing directly so the caller can choose the
 * exact 409 message without this function importing route-specific wording.
 */
export async function hardDeleteLease(orgId: string, db: Database, id: string): Promise<boolean | 'blocked'> {
  const current = await getLease(orgId, db, id);
  if (!current) return false;
  if (current.status !== 'draft' && current.status !== 'cancelled') return 'blocked';

  const result = await hardDeleteLeaseQuery(orgId, db, id);
  if (result.length === 0) return false;

  // The roster of a draft/cancelled lease never went live in any billing sense —
  // clean it up rather than leaving orphaned rows a future query would have to
  // remember to filter by the lease's own deletedAt.
  await db.delete(leaseTenant).where(and(eq(leaseTenant.orgId, orgId), eq(leaseTenant.leaseId, id)));

  return true;
}

/* ======================================================================== *
 * roster — add / remove / set primary (§5.5)
 * ======================================================================== */

export async function addLeaseTenant(
  orgId: string,
  db: Database,
  leaseId: string,
  data: AddLeaseTenantBody,
): Promise<LeaseTenantRow | null> {
  const current = await getLease(orgId, db, leaseId);
  if (!current) return null;

  if (current.status === 'ended' || current.status === 'terminated' || current.status === 'cancelled') {
    throw conflict('This lease has already ended. Start a new lease instead.');
  }

  // §7.1's guard again: `POST /v1/leases/{own draft}/tenants { tenantId: A_tenant }`
  // must 404, never insert a foreign tenant onto this org's lease.
  const resolved = await resolveTenantIds(orgId, db, [data.tenantId]);
  if (resolved.length === 0) throw notFound('Tenant');

  const roster = await listLeaseTenants(orgId, db, leaseId);
  if (roster.some((t) => t.tenantId === data.tenantId && t.removedOn === null)) {
    throw conflict('This tenant is already on this lease.');
  }

  // No clock read here — defaults to the lease's own startDate. `removeLeaseTenant`
  // below is the one place in Phase 2 that reads localToday (the contract comment
  // on removeLeaseTenantBody), so adding one here would make that claim false.
  const addedOn = data.addedOn ?? current.startDate;

  if (data.isPrimary) {
    await db
      .update(leaseTenant)
      .set({ isPrimary: false })
      .where(
        and(
          eq(leaseTenant.orgId, orgId),
          eq(leaseTenant.leaseId, leaseId),
          eq(leaseTenant.isPrimary, true),
          isNull(leaseTenant.removedOn),
        ),
      );
  }

  try {
    await db.insert(leaseTenant).values({
      id: uuidv7(),
      orgId,
      leaseId,
      tenantId: data.tenantId,
      isPrimary: data.isPrimary,
      addedOn,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('This tenant is already on this lease.');
    throw err;
  }

  const created = (await listLeaseTenants(orgId, db, leaseId)).find((t) => t.tenantId === data.tenantId);
  if (!created) throw new Error('Lease tenant not found immediately after insert');
  return created;
}

export async function removeLeaseTenant(
  orgId: string,
  db: Database,
  leaseId: string,
  tenantId: string,
  data: RemoveLeaseTenantBody,
): Promise<LeaseTenantRow | null> {
  const current = await getLease(orgId, db, leaseId);
  if (!current) return null;

  const roster = await listLeaseTenants(orgId, db, leaseId);
  const target = roster.find((t) => t.tenantId === tenantId && t.removedOn === null);
  if (!target) return null;

  if (target.isPrimary) {
    throw conflict('Reassign the primary tenant with /primary before removing them.');
  }

  const liveCount = roster.filter((t) => t.removedOn === null).length;
  if (current.status === 'active' && liveCount <= 1) {
    throw conflict('Cannot remove the last remaining tenant from an active lease. End the lease instead.');
  }

  // The one place in Phase 2 that reads the clock — in the PROPERTY's zone, per
  // removeLeaseTenantBody's contract comment.
  const removedOn = data.removedOn ?? localToday(current.propertyTimezone);

  const result = await db
    .update(leaseTenant)
    .set({ removedOn })
    .where(
      and(
        eq(leaseTenant.orgId, orgId),
        eq(leaseTenant.leaseId, leaseId),
        eq(leaseTenant.tenantId, tenantId),
        isNull(leaseTenant.removedOn),
      ),
    )
    .returning({ id: leaseTenant.id });
  if (result.length === 0) return null;

  return (await listLeaseTenants(orgId, db, leaseId)).find((t) => t.tenantId === tenantId) ?? null;
}

export async function setPrimaryTenant(
  orgId: string,
  db: Database,
  leaseId: string,
  tenantId: string,
): Promise<LeaseTenantRow | null> {
  const current = await getLease(orgId, db, leaseId);
  if (!current) return null;

  // Includes removed rows, unlike every other roster lookup here — this route
  // must 409 "already removed" for someone who WAS on the roster, not 404.
  const [row] = await db
    .select({ tenantId: leaseTenant.tenantId, removedOn: leaseTenant.removedOn })
    .from(leaseTenant)
    .where(and(eq(leaseTenant.orgId, orgId), eq(leaseTenant.leaseId, leaseId), eq(leaseTenant.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;
  if (row.removedOn !== null) throw conflict('This tenant has already been removed from the lease.');

  await db
    .update(leaseTenant)
    .set({ isPrimary: false })
    .where(
      and(
        eq(leaseTenant.orgId, orgId),
        eq(leaseTenant.leaseId, leaseId),
        eq(leaseTenant.isPrimary, true),
        isNull(leaseTenant.removedOn),
      ),
    );

  await db
    .update(leaseTenant)
    .set({ isPrimary: true })
    .where(
      and(
        eq(leaseTenant.orgId, orgId),
        eq(leaseTenant.leaseId, leaseId),
        eq(leaseTenant.tenantId, tenantId),
        isNull(leaseTenant.removedOn),
      ),
    );

  return (await listLeaseTenants(orgId, db, leaseId)).find((t) => t.tenantId === tenantId) ?? null;
}
