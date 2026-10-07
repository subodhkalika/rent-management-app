import { and, asc, desc, eq, gt, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import {
  uuidv7,
  addDays,
  compareIsoDate,
  localToday,
  statusForEndReason,
  validateBillingTerms,
  generateRentSteps,
  type CreateLeaseBody,
  type UpdateLeaseBody,
  type EndLeaseBody,
  type RenewLeaseBody,
  type AddLeaseTenantBody,
  type RemoveLeaseTenantBody,
  type LeaseBillingTerms,
  type RentEscalation,
  type RentStep,
  type RentStepInput,
  type PutRentStepsBody,
  type CorrectRentStepBody,
  type DraftRentStep,
} from '@rms/contract';
import type { Database } from '../index.js';
import { lease, leaseTenant, leaseRentStep, leaseRentStepCorrection, unit, property, tenant, user } from '../schema.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { decodeCursor } from '../../lib/pagination.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { validateEndDateSchedulable } from '../../lib/schedule.js';
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
  // The escalation CLAUSE — raw columns, mapped to `escalation: RentEscalation |
  // null` by `escalationFromRow` below / `mapLeaseSummary`. Never the schedule's
  // source of truth — see the module comment on the rent-step section.
  escalationMode: (typeof lease.$inferSelect)['escalationMode'];
  escalationRateBps: number | null;
  escalationIntervalYears: number | null;
  escalationCompounding: (typeof lease.$inferSelect)['escalationCompounding'];
  tenantCount: number;
  primaryTenantName: string | null;
  renewedFromLeaseId: string | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Live (removed_on IS NULL) roster count per lease, scoped to this org. A
 * CORRELATED SCALAR subquery, not a joined derived table: an earlier version used
 * `LEFT JOIN (SELECT ... GROUP BY lease_id) tenant_count` and referenced its
 * `.count` column directly in the outer select, which Postgres then rejected with
 * `column reference "count" is ambiguous` (and the equivalent primary-tenant-name
 * subquery with `"name"`, colliding with `property.name`) — Drizzle 0.45's render
 * of a column pulled straight off an `.as(...)`-aliased derived table does not
 * reliably table-qualify it in the surrounding query. A correlated subquery sidesteps
 * the whole class of bug: it has no separate FROM-list entry to collide with.
 */
function tenantCountColumn(orgId: string) {
  return sql<number>`(
    select count(*) from ${leaseTenant}
    where ${leaseTenant.leaseId} = ${lease.id}
      and ${leaseTenant.orgId} = ${orgId}
      and ${leaseTenant.removedOn} is null
  )`.mapWith(Number);
}

/** The live primary tenant's display name per lease. At most one row per lease by
 *  construction (`lease_tenant_primary_uq`). Same correlated-subquery reasoning
 *  as `tenantCountColumn` above. */
function primaryTenantNameColumn(orgId: string) {
  return sql<string | null>`(
    select ${tenant.firstName} || ' ' || ${tenant.lastName}
    from ${leaseTenant}
    inner join ${tenant} on ${tenant.id} = ${leaseTenant.tenantId}
    where ${leaseTenant.leaseId} = ${lease.id}
      and ${leaseTenant.orgId} = ${orgId}
      and ${leaseTenant.isPrimary} = true
      and ${leaseTenant.removedOn} is null
    limit 1
  )`;
}

/** The column map shared by every lease read below. Split out so the aggregate
 *  math (tenantCount / primaryTenantName) is defined exactly once. */
function leaseColumns(orgId: string) {
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
    escalationMode: lease.escalationMode,
    escalationRateBps: lease.escalationRateBps,
    escalationIntervalYears: lease.escalationIntervalYears,
    escalationCompounding: lease.escalationCompounding,
    tenantCount: tenantCountColumn(orgId),
    primaryTenantName: primaryTenantNameColumn(orgId),
    renewedFromLeaseId: lease.renewedFromLeaseId,
    endReason: lease.endReason,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
  };
}

/**
 * Raw `lease.escalation_*` columns -> the contract's `RentEscalation | null`. Pure
 * reshaping, no query — shared by every mapper and by `renewLease` (which carries
 * the predecessor's clause forward by default). `'none'` is never a value of
 * `RentEscalation`; it is the absence of one (packages/contract/src/billing.ts).
 */
export function escalationFromRow(row: {
  escalationMode: (typeof lease.$inferSelect)['escalationMode'];
  escalationRateBps: number | null;
  escalationIntervalYears: number | null;
  escalationCompounding: (typeof lease.$inferSelect)['escalationCompounding'];
}): RentEscalation | null {
  if (row.escalationMode === 'none') return null;
  return {
    mode: 'percent',
    rateBps: row.escalationRateBps!,
    intervalYears: row.escalationIntervalYears!,
    compounding: row.escalationCompounding!,
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
    .select(leaseColumns(orgId))
    .from(lease)
    // Scoped by orgId too, not just the FK — belt-and-suspenders, same reasoning
    // as property.ts's unit join.
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
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
  return db
    .select(leaseColumns(orgId))
    .from(lease)
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
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
  rentSteps: RentStepRow[];
}

export function getLeaseDetailQuery(orgId: string, db: Database, id: string) {
  return db
    .select({
      ...leaseColumns(orgId),
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
    .where(and(eq(lease.orgId, orgId), eq(lease.id, id), isNull(lease.deletedAt)))
    .limit(1);
}

export async function getLeaseDetail(orgId: string, db: Database, id: string): Promise<LeaseDetailRow | null> {
  const [row] = await getLeaseDetailQuery(orgId, db, id);
  if (!row) return null;

  const [tenants, chain, rentSteps] = await Promise.all([
    listLeaseTenants(orgId, db, id),
    getChain(orgId, db, row.chainId),
    listRentSteps(orgId, db, id),
  ]);

  return { ...row, tenants, chain, rentSteps };
}

/* ======================================================================== *
 * rent steps — the stored ladder (PLAN-ESCALATION.md §2.3, §5). Every function
 * here lives in THIS file, not a new repo module — the escalation plan §4.6/§7.2
 * is explicit that `MIN_LANDLORD_REPO_FILES` must not be bumped for this feature.
 * ======================================================================== */

export interface RentStepRow {
  id: string;
  leaseId: string;
  effectiveFrom: string;
  rentCents: number;
  source: (typeof leaseRentStep.$inferSelect)['source'];
  clauseExpectedCents: number | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function rentStepColumns() {
  return {
    id: leaseRentStep.id,
    leaseId: leaseRentStep.leaseId,
    effectiveFrom: leaseRentStep.effectiveFrom,
    rentCents: leaseRentStep.rentCents,
    source: leaseRentStep.source,
    clauseExpectedCents: leaseRentStep.clauseExpectedCents,
    note: leaseRentStep.note,
    createdAt: leaseRentStep.createdAt,
    updatedAt: leaseRentStep.updatedAt,
  };
}

/** Ascending by `effectiveFrom` — the order `rentForPeriodStart` (and I20) require. */
export function listRentStepsQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select(rentStepColumns())
    .from(leaseRentStep)
    .where(and(eq(leaseRentStep.orgId, orgId), eq(leaseRentStep.leaseId, leaseId)))
    .orderBy(asc(leaseRentStep.effectiveFrom));
}

export async function listRentSteps(orgId: string, db: Database, leaseId: string): Promise<RentStepRow[]> {
  return listRentStepsQuery(orgId, db, leaseId);
}

/**
 * `RentStepRow[]` narrowed to exactly what `billingTermsFor`/`buildSchedule` need
 * (`RentStep = { effectiveFrom, rentCents }`) — a plain reshape, not a query.
 */
export function toRentSteps(rows: readonly RentStepRow[]): RentStep[] {
  return rows.map((r) => ({ effectiveFrom: r.effectiveFrom, rentCents: r.rentCents }));
}

/**
 * What gets WRITTEN to `lease_rent_step` for one incoming step, at create or via
 * `PUT /rent-steps`. `clauseExpectedCents` is not part of `rentStepInput` (the
 * client's wire shape never carries it — see lease.ts's contract comment on
 * `rentStepSummary`), so it is derived here: a `'clause'`-sourced step has nothing
 * else to show — "what it says IS what was agreed" (the same rule
 * `recomputeLadderFrom` documents for a step still driven by the clause) — so its
 * `clauseExpectedCents` is its own `rentCents`. A `'manual'` step carries `null`
 * unless it was generated as `'clause'` and later edited IN THE SAME REQUEST
 * (never true for a verbatim client-supplied array, since the client sends only
 * the FINAL source/value pair) — the frozen "agreed X" figure from an earlier save
 * is intentionally not reconstructed here; see this agent's final report for why.
 */
function toInsertableStep(
  orgId: string,
  leaseId: string,
  step: RentStepInput,
): typeof leaseRentStep.$inferInsert {
  return {
    id: uuidv7(),
    orgId,
    leaseId,
    effectiveFrom: step.effectiveFrom,
    rentCents: step.rentCents,
    source: step.source,
    clauseExpectedCents: step.source === 'clause' ? step.rentCents : null,
    note: step.note ?? null,
  };
}

/** Same shape, for steps the GENERATOR drafted (`generateRentSteps`) rather than
 *  ones a client posted — `clauseExpectedCents` comes straight from the draft. */
function toInsertableDraftStep(
  orgId: string,
  leaseId: string,
  step: { effectiveFrom: string; rentCents: number; source: 'clause' | 'manual'; clauseExpectedCents: number | null },
): typeof leaseRentStep.$inferInsert {
  return {
    id: uuidv7(),
    orgId,
    leaseId,
    effectiveFrom: step.effectiveFrom,
    rentCents: step.rentCents,
    source: step.source,
    clauseExpectedCents: step.clauseExpectedCents,
    note: null,
  };
}

/** `rows` are already fully-formed inserts (`toInsertableStep`/`toInsertableDraftStep`
 *  set `orgId`/`leaseId` themselves) — `orgId`/`leaseId` params exist so this
 *  function's own signature still reads `orgId` first and references it, per the
 *  tenancy guard's convention for every write on an org-owned table. */
export function insertRentStepsQuery(
  orgId: string,
  db: Database,
  leaseId: string,
  rows: readonly (typeof leaseRentStep.$inferInsert)[],
) {
  return db.insert(leaseRentStep).values(rows.map((r) => ({ ...r, orgId, leaseId })));
}

/**
 * Resolves what to write at CREATE (and RENEW) time, per the escalation plan §4.3:
 * a client-supplied `rentSteps` array is written VERBATIM; an omitted one, with a
 * clause present, is drafted by the contract's own `generateRentSteps` — the same
 * function the browser calls, so the ladder is byte-identical either way. Pure —
 * no query — so it is independently testable without a database.
 */
export type StepsToWrite =
  | { from: 'verbatim'; steps: readonly RentStepInput[] }
  | { from: 'generated'; steps: readonly DraftRentStep[] }
  | { from: 'none' };

export function resolveStepsToWrite(input: {
  rentSteps: readonly RentStepInput[] | undefined;
  escalation: RentEscalation | null;
  baseRentCents: number;
  startDate: string;
  endDate: string | null;
  frequency: LeaseBillingTerms['frequency'];
  calendar: LeaseBillingTerms['calendar'];
}): StepsToWrite {
  if (input.rentSteps !== undefined) {
    return { from: 'verbatim', steps: input.rentSteps };
  }
  if (input.escalation !== null) {
    const drafted = generateRentSteps({
      clause: input.escalation,
      baseRentCents: input.baseRentCents,
      startDate: input.startDate,
      endDate: input.endDate,
      frequency: input.frequency,
      calendar: input.calendar,
    });
    return { from: 'generated', steps: drafted };
  }
  return { from: 'none' };
}

function insertableRowsFor(orgId: string, leaseId: string, resolved: StepsToWrite): (typeof leaseRentStep.$inferInsert)[] {
  if (resolved.from === 'verbatim') return resolved.steps.map((s) => toInsertableStep(orgId, leaseId, s));
  if (resolved.from === 'generated') return resolved.steps.map((s) => toInsertableDraftStep(orgId, leaseId, s));
  return [];
}

/**
 * Pure: every reason `PUT /rent-steps` 409s or 422s, before any query runs.
 * `today` is the caller's `localToday(property.timezone)` — never computed here.
 * Exported so the route/repo split stays testable without a database.
 *
 * PLAN-ESCALATION.md §4.5's table: a `draft` lease has no past — it has never
 * billed anything, so there is no money a correction could protect, and a step
 * dated behind `today` is exactly as free to replace as one ahead of it. This
 * is also what makes onboarding a backdated tenancy (§4.3) workable: a draft's
 * ladder can include already-past steps without forcing `/correct` for an event
 * that never happened. The date-based restriction below is unchanged for every
 * OTHER status — `active`, `ended`, `terminated` all still require `/correct`
 * for a step at or before `today`. The moment a lease activates it has a real
 * past; see `activateLease`'s comment for why activation itself needs no extra
 * guard here.
 */
export function validateStepReplacement(input: {
  leaseStatus: LeaseStatusValue;
  existing: readonly { effectiveFrom: string; rentCents: number }[];
  incoming: readonly RentStepInput[];
  today: string;
}): { kind: 'conflict'; message: string } | null {
  if (input.leaseStatus === 'cancelled') {
    return { kind: 'conflict', message: 'A cancelled lease cannot be changed.' };
  }
  if (input.leaseStatus === 'draft') {
    return null;
  }

  const existingByDate = new Map(input.existing.map((s) => [s.effectiveFrom, s.rentCents]));
  const incomingByDate = new Map(input.incoming.map((s) => [s.effectiveFrom, s.rentCents]));

  for (const [effectiveFrom, oldRentCents] of existingByDate) {
    if (compareIsoDate(effectiveFrom, input.today) > 0) continue; // a future step — free to edit/remove
    const newRentCents = incomingByDate.get(effectiveFrom);
    if (newRentCents === undefined || newRentCents !== oldRentCents) {
      return {
        kind: 'conflict',
        message: 'This increase has already taken effect. Use Correct, and tell us why.',
      };
    }
  }

  for (const [effectiveFrom] of incomingByDate) {
    if (compareIsoDate(effectiveFrom, input.today) > 0) continue;
    if (!existingByDate.has(effectiveFrom)) {
      return {
        kind: 'conflict',
        message: 'A rent increase cannot be backdated. Correct the step that is in force instead.',
      };
    }
  }

  return null;
}

/**
 * `PUT /v1/leases/:id/rent-steps` — replaces the WHOLE ladder (decision 4.1: one
 * endpoint, one rule). Mutability is `validateStepReplacement` above; ordering/
 * period-start/>-startDate validity is the contract's `validateBillingTerms` —
 * both of I20's cross-row rules live there, never as a DB CHECK (schema.ts's own
 * comment on `lease_rent_step` explains why neither half can be one).
 *
 * No interactive transaction (the Neon HTTP driver has none — PLAN-PHASE2.md
 * §5.4): delete-then-insert is two statements. A failure between them leaves a
 * lease with zero steps — visible and harmless (the base rent still applies via
 * `rentForPeriodStart`'s early return), fixed by retrying the PUT, the same
 * tolerance this codebase already accepts for `createLease`'s own roster insert.
 */
export async function replaceRentSteps(
  orgId: string,
  db: Database,
  leaseId: string,
  body: PutRentStepsBody,
): Promise<RentStepRow[] | null> {
  const current = await getLease(orgId, db, leaseId);
  if (!current) return null;

  const today = localToday(current.propertyTimezone);
  const existing = await listRentSteps(orgId, db, leaseId);

  const replacementIssue = validateStepReplacement({
    leaseStatus: current.status,
    existing,
    incoming: body.steps,
    today,
  });
  if (replacementIssue) throw conflict(replacementIssue.message);

  const terms: LeaseBillingTerms = {
    frequency: current.rentFrequency,
    rentCents: current.rentCents,
    billingDay: current.billingDay,
    startDate: current.startDate,
    endDate: current.endDate,
    ledgerStartDate: current.ledgerStartDate,
    moveOutDate: current.moveOutDate,
    moveOutBillingPolicy: current.moveOutBillingPolicy,
    calendar: current.calendar,
    rentSteps: body.steps.map((s) => ({ effectiveFrom: s.effectiveFrom, rentCents: s.rentCents })),
  };
  const billingError = validateBillingTerms(terms);
  if (billingError) throw validationFailed({ _: [billingError] });

  await db.delete(leaseRentStep).where(and(eq(leaseRentStep.orgId, orgId), eq(leaseRentStep.leaseId, leaseId)));
  if (body.steps.length > 0) {
    await insertRentStepsQuery(orgId, db, leaseId, body.steps.map((s) => toInsertableStep(orgId, leaseId, s)));
  }

  return listRentSteps(orgId, db, leaseId);
}

/**
 * `POST /v1/leases/:id/rent-steps/:stepId/correct` — THE one genuinely new
 * cross-org shape in the escalation plan (§4.6). `stepId` arrives on the PATH, so
 * it is resolved by `(org_id, lease_id, id)` — never by `id` alone — in the SAME
 * query that reads the row, so a foreign step id can never be distinguished from
 * one that simply does not exist. Both read as "not found" to the caller.
 */
export function resolveRentStepQuery(orgId: string, db: Database, leaseId: string, stepId: string) {
  return db
    .select(rentStepColumns())
    .from(leaseRentStep)
    .where(
      and(eq(leaseRentStep.orgId, orgId), eq(leaseRentStep.leaseId, leaseId), eq(leaseRentStep.id, stepId)),
    )
    .limit(1);
}

export async function resolveRentStep(
  orgId: string,
  db: Database,
  leaseId: string,
  stepId: string,
): Promise<RentStepRow | null> {
  const [row] = await resolveRentStepQuery(orgId, db, leaseId, stepId);
  return row ?? null;
}

/**
 * Corrects a step that has ALREADY taken effect, writing exactly one
 * `lease_rent_step_correction` row (the money audit — schema.ts's own comment).
 * A future step 409s here and must go through `PUT /rent-steps` instead, per the
 * escalation plan §4.1 — "has it taken effect" is the one date comparison that
 * decides which route a landlord uses.
 */
export async function correctRentStep(
  orgId: string,
  db: Database,
  leaseId: string,
  stepId: string,
  userId: string,
  data: CorrectRentStepBody,
): Promise<RentStepRow | null> {
  const current = await getLease(orgId, db, leaseId);
  if (!current) return null;
  if (current.status === 'cancelled') throw conflict('A cancelled lease cannot be changed.');

  // THE cross-org-safe resolve — (org_id, lease_id, id), never id alone.
  const step = await resolveRentStep(orgId, db, leaseId, stepId);
  if (!step) return null;

  const today = localToday(current.propertyTimezone);
  if (compareIsoDate(step.effectiveFrom, today) > 0) {
    throw conflict('This increase has not taken effect yet — edit it directly.');
  }

  const oldRentCents = step.rentCents;

  await db
    .update(leaseRentStep)
    .set({ rentCents: data.rentCents, source: 'manual', updatedAt: new Date() })
    .where(and(eq(leaseRentStep.orgId, orgId), eq(leaseRentStep.leaseId, leaseId), eq(leaseRentStep.id, stepId)));

  await db.insert(leaseRentStepCorrection).values({
    id: uuidv7(),
    orgId,
    leaseId,
    stepId,
    effectiveFrom: step.effectiveFrom,
    oldRentCents,
    newRentCents: data.rentCents,
    reason: data.reason,
    correctedByUserId: userId,
  });

  return resolveRentStep(orgId, db, leaseId, stepId);
}

export interface RentStepCorrectionRow {
  id: string;
  leaseId: string;
  stepId: string;
  effectiveFrom: string;
  oldRentCents: number;
  newRentCents: number;
  reason: string;
  correctedByUserId: string;
  correctedByName: string | null;
  createdAt: Date;
}

export function listRentStepCorrectionsQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select({
      id: leaseRentStepCorrection.id,
      leaseId: leaseRentStepCorrection.leaseId,
      stepId: leaseRentStepCorrection.stepId,
      effectiveFrom: leaseRentStepCorrection.effectiveFrom,
      oldRentCents: leaseRentStepCorrection.oldRentCents,
      newRentCents: leaseRentStepCorrection.newRentCents,
      reason: leaseRentStepCorrection.reason,
      correctedByUserId: leaseRentStepCorrection.correctedByUserId,
      // Nullable so a deleted user account never breaks rendering an old
      // correction (rentStepCorrection's own contract comment).
      correctedByName: user.name,
      createdAt: leaseRentStepCorrection.createdAt,
    })
    .from(leaseRentStepCorrection)
    .leftJoin(user, eq(user.id, leaseRentStepCorrection.correctedByUserId))
    .where(and(eq(leaseRentStepCorrection.orgId, orgId), eq(leaseRentStepCorrection.leaseId, leaseId)))
    .orderBy(desc(leaseRentStepCorrection.createdAt));
}

export async function listRentStepCorrections(
  orgId: string,
  db: Database,
  leaseId: string,
): Promise<RentStepCorrectionRow[]> {
  return listRentStepCorrectionsQuery(orgId, db, leaseId);
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

/**
 * Leases under this property that are NOT `draft`/`cancelled` — the guard for
 * `PATCH /v1/properties/:id { calendar }` (not a §3.6 delete guard, but the same
 * shape). Broader than `countActiveLeasesForProperty`: an `ended`/`terminated`
 * lease still blocks a calendar change, because its chain's charge key-space
 * (`generationKey`, derived from `periodStart`) was already written under the old
 * calendar — flipping the property's calendar would make Phase 3's generator see
 * an entirely new key set for that lease and write a second parallel set of
 * charges alongside the ones already billed, not merely change an amount the way
 * `move_out_billing_policy` does (Amendment A.3's live-read argument does not
 * extend to the calendar).
 */
export function countNonDraftLeasesForPropertyQuery(orgId: string, db: Database, propertyId: string) {
  return db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(lease)
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .where(
      and(
        eq(lease.orgId, orgId),
        eq(unit.propertyId, propertyId),
        isNull(lease.deletedAt),
        notInArray(lease.status, ['draft', 'cancelled']),
      ),
    );
}

export async function countNonDraftLeasesForProperty(orgId: string, db: Database, propertyId: string): Promise<number> {
  const [row] = await countNonDraftLeasesForPropertyQuery(orgId, db, propertyId);
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
    escalationMode: data.escalation ? 'percent' : 'none',
    escalationRateBps: data.escalation?.rateBps ?? null,
    escalationIntervalYears: data.escalation?.intervalYears ?? null,
    escalationCompounding: data.escalation?.compounding ?? null,
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

  // THE MODEL (escalation plan §4.3): a client-supplied `rentSteps` is written
  // VERBATIM; an omitted one, with a clause present, is drafted by the contract's
  // own `generateRentSteps` — the same function the browser calls, so the ladder
  // is byte-identical either way. `data.rentSteps` is undefined vs. present is
  // exactly createLeaseBody's own distinction (it has no default, unlike
  // `escalation`), so no body-inspection workaround is needed here.
  const stepsToWrite = resolveStepsToWrite({
    rentSteps: data.rentSteps,
    escalation: data.escalation,
    baseRentCents: data.rentCents,
    startDate: data.startDate,
    endDate: data.endDate ?? null,
    frequency: data.rentFrequency,
    calendar: propertyRow.calendar,
  });
  const rentStepsForValidation: RentStep[] =
    stepsToWrite.from === 'none' ? [] : stepsToWrite.steps.map((s) => ({ effectiveFrom: s.effectiveFrom, rentCents: s.rentCents }));

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
    rentSteps: rentStepsForValidation,
  };
  const billingError = validateBillingTerms(terms);
  if (billingError) throw validationFailed({ _: [billingError] });

  // Refuse an endDate the property's calendar cannot schedule, up front — not
  // only when someone later asks for the schedule (lib/schedule.ts).
  const rangeError = validateEndDateSchedulable(propertyRow.calendar, terms.endDate);
  if (rangeError) throw validationFailed({ endDate: [rangeError] });

  const id = uuidv7();
  // Write order (PLAN-PHASE2.md §5.4 / escalation plan §4.3): lease row -> steps
  // -> roster. A torn failure between these leaves a draft with a base rent and no
  // ladder (or no roster) — visible, harmless, and activation never depends on
  // either existing.
  await createLeaseQuery(orgId, db, id, userId, data.unitId, unitRow.currency, ledgerStartDate, data);

  const stepRows = insertableRowsFor(orgId, id, stepsToWrite);
  if (stepRows.length > 0) {
    await insertRentStepsQuery(orgId, db, id, stepRows);
  }

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
  /**
   * Whether the CLIENT actually included `escalation` in the request — NOT
   * `patch.escalation !== undefined`. `updateLeaseBody`'s `escalation` field
   * carries `.default(null)` (inherited from `createLeaseBodyShape`), so
   * `zod.parse` fills it in as `null` on every PATCH that never mentions it —
   * `patch.escalation` is therefore defined on EVERY real HTTP request regardless
   * of client intent. The route computes this from the raw pre-parse body (see
   * `middleware/validate.ts`'s `rawBody`) and passes it in; direct repo callers
   * (tests, scripts) building a plain `UpdateLeaseBody` object may omit this
   * parameter — it then falls back to `patch.escalation !== undefined`, which is
   * correct for a hand-built object that was never run through zod.
   */
  escalationProvided: boolean = patch.escalation !== undefined,
): string | null {
  if (status === 'draft') return null;

  // The clause is documentation, not money — editable on any status but
  // cancelled (escalation plan §4.1, decision 15). Checked up front so it is
  // reachable on 'ended'/'terminated' without being folded into their terminal
  // allow-list below, and short-circuits before RENEW_FIELDS so escalation is
  // never confused for a term-defining field.
  if (status === 'cancelled' && escalationProvided) {
    return 'A cancelled lease cannot be changed.';
  }

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

  // ended / terminated / cancelled: only notes, moveOutDate, and (per the
  // escalation-provided check above) the clause. `escalation` is skipped here
  // unconditionally rather than added to ALLOWED_TERMINAL — a plain membership
  // check on `patch.escalation !== undefined` would be the exact bug this whole
  // parameter exists to avoid (it is ALWAYS defined on a real HTTP PATCH).
  const ALLOWED_TERMINAL = new Set(['notes', 'moveOutDate']);
  for (const key of Object.keys(patch) as (keyof UpdateLeaseBody)[]) {
    if (key === 'escalation') continue;
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
  opts: { currency?: string; escalationProvided?: boolean; userId?: string } = {},
) {
  const patch: Partial<typeof lease.$inferInsert> = { updatedAt: new Date() };
  if (data.unitId !== undefined) patch.unitId = data.unitId;
  if (opts.currency !== undefined) patch.currency = opts.currency;
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
  // See illegalUpdateField's own comment on why "touched" is `opts.escalationProvided`,
  // never `data.escalation !== undefined` — the latter is always true after zod
  // parsing because `escalation` carries a default.
  if (opts.escalationProvided) {
    patch.escalationMode = data.escalation ? 'percent' : 'none';
    patch.escalationRateBps = data.escalation?.rateBps ?? null;
    patch.escalationIntervalYears = data.escalation?.intervalYears ?? null;
    patch.escalationCompounding = data.escalation?.compounding ?? null;
    patch.escalationUpdatedAt = new Date();
    patch.escalationUpdatedByUserId = opts.userId ?? null;
  }

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
  opts: { userId?: string; escalationProvided?: boolean } = {},
): Promise<LeaseRow | null> {
  const current = await getLease(orgId, db, id);
  if (!current) return null;

  const escalationProvided = opts.escalationProvided ?? data.escalation !== undefined;

  const illegal = illegalUpdateField(current.status, data, { endDate: current.endDate }, escalationProvided);
  if (illegal) throw conflict(illegal);

  // Resolve the NEW unit (and its property) FIRST, when unitId is changing —
  // illegalUpdateField only lets unitId through on a draft lease (it's one of
  // RENEW_FIELDS on anything else), so this only ever runs pre-activation. Moving
  // a draft to a unit under a different property must revalidate against THAT
  // property's calendar and move-out policy, never the old one — otherwise a
  // billingDay valid only under the old calendar (or an endDate the new
  // calendar's table can't represent) would be written unchecked.
  let currency: string | undefined;
  let calendarForValidation = current.calendar;
  let policyForValidation = current.moveOutBillingPolicy;
  if (data.unitId !== undefined && data.unitId !== current.unitId) {
    const unitRow = await unitRepo.getUnit(orgId, db, data.unitId);
    if (!unitRow) throw notFound('Unit');
    currency = unitRow.currency;

    const propertyRow = await propertyRepo.getProperty(orgId, db, unitRow.propertyId);
    if (!propertyRow) throw notFound('Unit');
    calendarForValidation = propertyRow.calendar;
    policyForValidation = propertyRow.moveOutBillingPolicy;
  }

  const BILLING_FIELDS = ['unitId', 'startDate', 'endDate', 'rentFrequency', 'billingDay', 'ledgerStartDate', 'moveOutDate', 'rentCents'] as const;
  const touchesBilling = BILLING_FIELDS.some((f) => data[f] !== undefined);
  if (touchesBilling) {
    // `rentSteps` is not part of `updateLeaseBody` (PUT /rent-steps owns the
    // ladder — lease.ts's own comment on why), but a PATCH here can still change
    // startDate/endDate/rentFrequency (on a draft) or endDate (on an active
    // lease), any of which can invalidate an EXISTING step's I20 position. The
    // existing steps are loaded so `validateBillingTerms` re-checks them against
    // the terms as they would read AFTER this patch — never against the clause.
    const existingSteps = await listRentSteps(orgId, db, id);
    const terms: LeaseBillingTerms = {
      frequency: data.rentFrequency ?? current.rentFrequency,
      rentCents: data.rentCents ?? current.rentCents,
      billingDay: data.billingDay ?? current.billingDay,
      startDate: data.startDate ?? current.startDate,
      endDate: data.endDate !== undefined ? (data.endDate ?? null) : current.endDate,
      ledgerStartDate: data.ledgerStartDate ?? current.ledgerStartDate,
      moveOutDate: data.moveOutDate !== undefined ? (data.moveOutDate ?? null) : current.moveOutDate,
      moveOutBillingPolicy: policyForValidation,
      calendar: calendarForValidation,
      rentSteps: toRentSteps(existingSteps),
    };
    const billingError = validateBillingTerms(terms);
    if (billingError) throw validationFailed({ _: [billingError] });

    const rangeError = validateEndDateSchedulable(terms.calendar, terms.endDate);
    if (rangeError) throw validationFailed({ endDate: [rangeError] });
  }

  const result = await updateLeaseQuery(orgId, db, id, data, { currency, escalationProvided, userId: opts.userId });
  if (result.length === 0) return null;
  return getLease(orgId, db, id);
}

/* ======================================================================== *
 * lifecycle transitions (§5)
 * ======================================================================== */

/**
 * Needs no rent-step guard for already-past `effectiveFrom` values. A draft is
 * allowed (§4.3, §4.5) to hold steps dated behind `today` — the backdated-
 * onboarding case — and this transition only flips `lease.status`; it never
 * touches `lease_rent_step` rows, so no step's date or source changes here.
 * Once this UPDATE commits, those same rows are read by the now-`active`
 * lease's `validateStepReplacement`, whose date-based rule (unchanged for
 * every non-draft status) immediately requires `/correct` for any of them —
 * which is correct: the moment a lease is active, a step at or before `today`
 * is money that was or will be billed, regardless of when the row was written.
 */
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

  let result: { id: string }[];
  try {
    result = await db
      .update(lease)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(lease.orgId, orgId), eq(lease.id, id), eq(lease.status, 'draft')))
      .returning({ id: lease.id });
  } catch (err) {
    // The race: two concurrent activates for the same unit. The pre-check above
    // is the nice message; this catch is the authority.
    if (isUniqueViolation(err)) throw conflict(UNIT_ACTIVE_CONFLICT_MESSAGE);
    throw err;
  }
  // `current` was just confirmed to exist and be `draft` moments ago, so the ONLY
  // way this UPDATE's WHERE (status = 'draft') now matches zero rows is a
  // concurrent request that changed this SAME lease's status in between — not
  // "the lease doesn't exist". 409, never 404: 404 would wrongly claim the row is
  // gone.
  if (result.length === 0) throw conflict('Only a draft lease can be activated.');

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

  const rangeError = validateEndDateSchedulable(current.calendar, data.endDate);
  if (rangeError) throw validationFailed({ endDate: [rangeError] });

  // lease_moveout_ck: move_out_date IS NULL OR move_out_date >= start_date. Validate
  // BEFORE the UPDATE — an unvalidated write here turns a landlord's typo into an
  // unhandled SQLSTATE 23514 (db-errors.ts only recognises 23505), which would 500
  // and leave the lease still active instead of 422ing with a field-level message.
  const nextMoveOutDate = data.moveOutDate !== undefined ? data.moveOutDate : current.moveOutDate;
  if (nextMoveOutDate !== null && compareIsoDate(nextMoveOutDate, current.startDate) < 0) {
    throw validationFailed({ moveOutDate: ['moveOutDate cannot be before the lease started.'] });
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

  // Assumption §9.2.3 of the escalation plan: a renewal carries the predecessor's
  // CLAUSE forward by default and re-anchors it on its OWN start/base — never the
  // predecessor's rentSteps, which belonged to a different term.
  const escalation = data.escalation !== undefined ? data.escalation : escalationFromRow(predecessor);
  const stepsToWrite = resolveStepsToWrite({
    rentSteps: data.rentSteps,
    escalation,
    baseRentCents: data.rentCents,
    startDate: data.startDate,
    endDate: data.endDate ?? null,
    frequency: rentFrequency,
    calendar: predecessor.calendar,
  });
  const rentStepsForValidation: RentStep[] =
    stepsToWrite.from === 'none' ? [] : stepsToWrite.steps.map((s) => ({ effectiveFrom: s.effectiveFrom, rentCents: s.rentCents }));

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
    rentSteps: rentStepsForValidation,
  };
  const billingError = validateBillingTerms(terms);
  if (billingError) throw validationFailed({ _: [billingError] });

  const rangeError = validateEndDateSchedulable(terms.calendar, terms.endDate);
  if (rangeError) throw validationFailed({ endDate: [rangeError] });

  // §5.4: end the predecessor FIRST, then insert the successor. Inserting first
  // would hit lease_unit_active_uq and 500 on the legitimate path.
  if (predecessor.status === 'active') {
    const predecessorEnd = addDays(data.startDate, -1);
    // lease_ledger_ck: ledger_start_date <= end_date. An onboarded predecessor
    // (ledgerStartDate set later than startDate, e.g. an in-flight tenancy) can
    // have its ledger start fall AFTER `newStart - 1` for a renewal requested soon
    // enough after the predecessor began — ending it there would violate the CHECK
    // and 500. Caught here, before the UPDATE, as a 409 naming the real conflict.
    if (compareIsoDate(predecessorEnd, predecessor.ledgerStartDate) < 0) {
      throw conflict(
        "The renewal's startDate is too soon after the predecessor's ledger start date. " +
          'Choose a later startDate.',
      );
    }
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
      escalationMode: escalation ? 'percent' : 'none',
      escalationRateBps: escalation?.rateBps ?? null,
      escalationIntervalYears: escalation?.intervalYears ?? null,
      escalationCompounding: escalation?.compounding ?? null,
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(UNIT_ACTIVE_CONFLICT_MESSAGE);
    throw err;
  }

  const stepRows = insertableRowsFor(orgId, id, stepsToWrite);
  if (stepRows.length > 0) {
    await insertRentStepsQuery(orgId, db, id, stepRows);
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

  // lease_tenant_ck: removed_on IS NULL OR removed_on >= added_on. Validate BEFORE
  // the UPDATE — same reasoning as endLease's moveOutDate check above: an
  // unvalidated write here is an unhandled SQLSTATE 23514, not a 422.
  if (compareIsoDate(removedOn, target.addedOn) < 0) {
    throw validationFailed({ removedOn: ['removedOn cannot be before the tenant was added to the lease.'] });
  }

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
