import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import {
  uuidv7,
  billingTermsFor,
  chargesDueForGeneration,
  maxIsoDate,
  DEPOSIT_GENERATION_KEY,
  OPENING_BALANCE_GENERATION_KEY,
  type ChargeListQuery,
  type OrgChargeListQuery,
  type CreateChargeBody,
  type VoidChargeBody,
  type CorrectChargeBody,
  type RentStep,
  type RentFrequency,
  type MoveOutBillingPolicy,
  type CalendarSystem,
  type IsoDate,
  type LeaseBillingTerms,
  type PlannedCharge,
} from '@rms/contract';
import type { Database } from '../index.js';
import { charge, lease, unit, property } from '../schema.js';
import { conflict } from '../../lib/errors.js';
import { decodeDueDateCursor } from '../../lib/pagination.js';
import { plannedChargeToInsert } from '../../lib/charge-mapper.js';

/**
 * ORDINARY orgId-first repo, exactly like lease.ts/unit.ts/property.ts — covered by
 * the same `tenancy.guard.test.ts`. `generateChargesForLease` (the generator) lives
 * HERE, not under `repo/system/`, and is called by both the cron
 * (`jobs/daily.ts`) and the manual-kick route — see `repo/system/charges.ts`'s own
 * module comment for why that split keeps the cross-org surface to one SELECT that
 * writes nothing.
 *
 * Must not import `repo/lease.ts` (PLAN-PHASE3A.md §11's backend task list) — every
 * function here takes a STRUCTURAL `GeneratableLease` rather than `lease.ts`'s own
 * `LeaseRow`, so this module has no dependency on it at all, in either direction.
 */

/* ======================================================================== *
 * row shape + column map, shared by every read below
 * ======================================================================== */

export interface ChargeRow {
  id: string;
  leaseId: string;
  type: (typeof charge.$inferSelect)['type'];
  generationKey: string | null;
  periodIndex: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  occupiedStart: string | null;
  occupiedEnd: string | null;
  daysOccupied: number | null;
  daysInPeriod: number | null;
  dueDate: string;
  amountCents: number;
  isProrated: boolean;
  currency: string;
  description: string | null;
  source: (typeof charge.$inferSelect)['source'];
  supersedesChargeId: string | null;
  voidedAt: Date | null;
  voidedReason: string | null;
  voidedByUserId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

// Exported so repo/ledger.ts's allocation query can select the FULL charge shape
// alongside its own computed `appliedCents` — one column-list definition, reused
// rather than duplicated (PLAN-PHASE3B.md §3.2's own correction 3: an explicit
// column list, never `c.*`).
export function chargeColumns() {
  return {
    id: charge.id,
    leaseId: charge.leaseId,
    type: charge.type,
    generationKey: charge.generationKey,
    periodIndex: charge.periodIndex,
    periodStart: charge.periodStart,
    periodEnd: charge.periodEnd,
    occupiedStart: charge.occupiedStart,
    occupiedEnd: charge.occupiedEnd,
    daysOccupied: charge.daysOccupied,
    daysInPeriod: charge.daysInPeriod,
    dueDate: charge.dueDate,
    amountCents: charge.amountCents,
    isProrated: charge.isProrated,
    currency: charge.currency,
    description: charge.description,
    source: charge.source,
    supersedesChargeId: charge.supersedesChargeId,
    voidedAt: charge.voidedAt,
    voidedReason: charge.voidedReason,
    voidedByUserId: charge.voidedByUserId,
    createdByUserId: charge.createdByUserId,
    createdAt: charge.createdAt,
  };
}

/* ======================================================================== *
 * GET /v1/leases/:id/charges — lease-scoped list
 * ======================================================================== */

export function listChargesQuery(orgId: string, db: Database, leaseId: string, opts: ChargeListQuery) {
  const conditions = [eq(charge.orgId, orgId), eq(charge.leaseId, leaseId)];
  if (!opts.includeVoided) conditions.push(isNull(charge.voidedAt));
  if (opts.from) conditions.push(gte(charge.dueDate, opts.from));
  if (opts.to) conditions.push(lte(charge.dueDate, opts.to));
  if (opts.type) conditions.push(eq(charge.type, opts.type));
  if (opts.cursor) {
    const c = decodeDueDateCursor(opts.cursor);
    conditions.push(sql`(${charge.dueDate}, ${charge.id}) > (${c.dueDate}::date, ${c.id}::uuid)`);
  }

  return db
    .select(chargeColumns())
    .from(charge)
    .where(and(...conditions))
    .orderBy(asc(charge.dueDate), asc(charge.id))
    .limit(opts.limit + 1);
}

export async function listCharges(
  orgId: string,
  db: Database,
  leaseId: string,
  opts: ChargeListQuery,
): Promise<{ rows: ChargeRow[]; hasMore: boolean }> {
  const rows = await listChargesQuery(orgId, db, leaseId, opts);
  const hasMore = rows.length > opts.limit;
  return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
}

/* ======================================================================== *
 * GET /v1/charges — portfolio-wide, across every property
 * ======================================================================== */

export interface ChargeWithLeaseRow extends ChargeRow {
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitLabel: string;
  propertyTimezone: string;
}

export function listChargesForOrgQuery(orgId: string, db: Database, opts: OrgChargeListQuery) {
  const conditions = [eq(charge.orgId, orgId)];
  if (!opts.includeVoided) conditions.push(isNull(charge.voidedAt));
  if (opts.from) conditions.push(gte(charge.dueDate, opts.from));
  if (opts.to) conditions.push(lte(charge.dueDate, opts.to));
  if (opts.type) conditions.push(eq(charge.type, opts.type));
  if (opts.unitId) conditions.push(eq(lease.unitId, opts.unitId));
  if (opts.propertyId) conditions.push(eq(unit.propertyId, opts.propertyId));
  if (opts.overdueOnly) {
    conditions.push(isNull(charge.voidedAt));
    // "Overdue" is decided in the PROPERTY's own timezone (chargeOverdue's own
    // contract rule) — with rows spanning many properties in one portfolio-wide
    // page, that is a per-row comparison, not a single server clock read. Postgres's
    // own tz database is what `localToday` delegates to in JS (via `Intl`); asking
    // it to do the equivalent per row in SQL is the same rule, not a second
    // implementation of it — no billing AMOUNT or DUE DATE is computed here, only a
    // listing filter over values already written.
    conditions.push(sql`${charge.dueDate} < (now() at time zone ${property.timezone})::date`);
  }
  if (opts.cursor) {
    const c = decodeDueDateCursor(opts.cursor);
    conditions.push(sql`(${charge.dueDate}, ${charge.id}) > (${c.dueDate}::date, ${c.id}::uuid)`);
  }

  return db
    .select({
      ...chargeColumns(),
      propertyId: property.id,
      propertyName: property.name,
      unitId: unit.id,
      unitLabel: unit.label,
      propertyTimezone: property.timezone,
    })
    .from(charge)
    .innerJoin(lease, and(eq(lease.id, charge.leaseId), eq(lease.orgId, orgId)))
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
    .where(and(...conditions))
    .orderBy(asc(charge.dueDate), asc(charge.id))
    .limit(opts.limit + 1);
}

export async function listChargesForOrg(
  orgId: string,
  db: Database,
  opts: OrgChargeListQuery,
): Promise<{ rows: ChargeWithLeaseRow[]; hasMore: boolean }> {
  const rows = await listChargesForOrgQuery(orgId, db, opts);
  const hasMore = rows.length > opts.limit;
  return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
}

/* ======================================================================== *
 * resolve — (org_id, lease_id, id). Same shape correctRentStep already uses for
 * stepId, for the same reason: one extra conjunct, zero ambiguity about whether a
 * bare id was scoped.
 * ======================================================================== */

export function resolveChargeQuery(orgId: string, db: Database, leaseId: string, chargeId: string) {
  return db
    .select(chargeColumns())
    .from(charge)
    .where(and(eq(charge.orgId, orgId), eq(charge.leaseId, leaseId), eq(charge.id, chargeId)))
    .limit(1);
}

export async function resolveCharge(
  orgId: string,
  db: Database,
  leaseId: string,
  chargeId: string,
): Promise<ChargeRow | null> {
  const [row] = await resolveChargeQuery(orgId, db, leaseId, chargeId);
  return row ?? null;
}

/**
 * A charge exists for this lease at all — voided or not. The precondition
 * `hardDeleteLease` (repo/lease.ts) checks before attempting the soft-delete, so a
 * lease with billing history fails with a clean 409 instead of the database's own
 * 23503 (`charge.lease_id` is `ON DELETE RESTRICT`) surfacing as an unhandled 500.
 */
export function existsChargeForLeaseQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select({ id: charge.id })
    .from(charge)
    .where(and(eq(charge.orgId, orgId), eq(charge.leaseId, leaseId)))
    .limit(1);
}

export async function existsChargeForLease(orgId: string, db: Database, leaseId: string): Promise<boolean> {
  const [row] = await existsChargeForLeaseQuery(orgId, db, leaseId);
  return row !== undefined;
}

/* ======================================================================== *
 * the rent-step mutability boundary (PLAN-PHASE3A.md §3.4)
 * ======================================================================== */

/**
 * MAX(period_start) over this lease's GENERATED rent charges — voided or not.
 * `null` when nothing has been generated yet (a draft, or an active lease the
 * cron has not yet reached).
 *
 * DELIBERATELY includes voided rows (review decision, 2026-10-09 — overriding an
 * earlier `isNull(voidedAt)` filter here). A period that was billed once stays
 * billed: its `charge_generation_uq` key is occupied forever regardless of void
 * status (schema.ts's own comment on that index), so the boundary this function
 * feeds must be MONOTONIC the same way. Filtering by `voidedAt IS NULL` let the
 * boundary RETREAT the moment the latest period was voided — a step dated at that
 * now-unguarded point would then take a free `PUT`, with no correction audit and
 * no reason, and the drift banner stays silent on it because the generation key
 * is still occupied (nothing reads as "missing"). The ladder would say one
 * number, the bill another, and nothing would tell anyone. A monotonic boundary
 * is also what §3.4's "exactly one of PUT/`/correct` accepts any given step"
 * actually requires — a boundary that can move backward can un-void a step's
 * mutability along with the charge, which `/correct`'s own audit trail is
 * supposed to prevent.
 */
export function latestChargedPeriodStartQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select({ latest: sql<string | null>`max(${charge.periodStart})` })
    .from(charge)
    .where(
      and(
        eq(charge.orgId, orgId),
        eq(charge.leaseId, leaseId),
        eq(charge.type, 'rent'),
        eq(charge.source, 'generated'),
      ),
    );
}

export async function latestChargedPeriodStart(
  orgId: string,
  db: Database,
  leaseId: string,
): Promise<IsoDate | null> {
  const [row] = await latestChargedPeriodStartQuery(orgId, db, leaseId);
  return (row?.latest as IsoDate | null) ?? null;
}

/**
 * The single shared threshold that lets `PUT /rent-steps` and
 * `POST /rent-steps/:stepId/correct` partition every step with no gap and no
 * overlap: `PUT` refuses a step at or before this boundary, `/correct` refuses a
 * step after it. Charges are written up to `GENERATION_LOOKAHEAD_DAYS` ahead of
 * `today`, so a step dated inside that window is ALREADY inside a written period —
 * `today` alone is not strict enough once billing has started.
 *
 * MONOTONIC, never decreasing for a given lease (`latestChargedPeriodStart`'s own
 * comment): voiding the latest-billed period must not hand its mutability back to
 * `PUT` with no audit trail.
 */
export async function rentStepMutabilityBoundary(
  orgId: string,
  db: Database,
  leaseId: string,
  today: IsoDate,
): Promise<IsoDate> {
  const latest = await latestChargedPeriodStart(orgId, db, leaseId);
  return latest === null ? today : maxIsoDate(today, latest);
}

/* ======================================================================== *
 * manual charges — create / void / correct
 * ======================================================================== */

function resolveLeaseForChargeQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select({ id: lease.id, status: lease.status, currency: lease.currency })
    .from(lease)
    .where(and(eq(lease.orgId, orgId), eq(lease.id, leaseId), isNull(lease.deletedAt)))
    .limit(1);
}

/**
 * `createChargeBody.type` is `manualChargeType` (deposit | late_fee | utility |
 * other) at the schema boundary already — `rent` is structurally absent, so a
 * manual charge can never compete with the generator's own generation key here.
 *
 * Refuses a `draft`/`cancelled` lease (409) — PLAN-PHASE3A.md §3.5: this is what
 * makes `hardDeleteLease`'s zero-charge invariant hold BY CONSTRUCTION for a draft
 * lease, in addition to the explicit precondition check.
 */
export async function createManualCharge(
  orgId: string,
  db: Database,
  leaseId: string,
  userId: string,
  data: CreateChargeBody,
): Promise<ChargeRow | null> {
  const [leaseRow] = await resolveLeaseForChargeQuery(orgId, db, leaseId);
  if (!leaseRow) return null;
  if (leaseRow.status === 'draft' || leaseRow.status === 'cancelled') {
    throw conflict('Charges cannot be added to a draft or cancelled lease.');
  }

  const id = uuidv7();
  await db.insert(charge).values({
    id,
    orgId,
    leaseId,
    type: data.type,
    periodStart: data.periodStart ?? null,
    periodEnd: data.periodEnd ?? null,
    periodIndex: null,
    occupiedStart: null,
    occupiedEnd: null,
    daysOccupied: null,
    daysInPeriod: null,
    dueDate: data.dueDate,
    amountCents: data.amountCents,
    currency: leaseRow.currency,
    description: data.description ?? null,
    isProrated: false,
    source: 'manual',
    generationKey: null,
    supersedesChargeId: null,
    createdByUserId: userId,
  });

  return resolveCharge(orgId, db, leaseId, id);
}

/**
 * The only mutation `charge` ever accepts: setting `voidedAt`/`voidedReason`/
 * `voidedByUserId`, once. The `WHERE voidedAt IS NULL` on the UPDATE is what makes
 * "already voided" authoritative against a concurrent double-void, not just the
 * pre-check above it.
 */
export async function voidCharge(
  orgId: string,
  db: Database,
  leaseId: string,
  chargeId: string,
  userId: string,
  data: VoidChargeBody,
): Promise<ChargeRow | null> {
  const existing = await resolveCharge(orgId, db, leaseId, chargeId);
  if (!existing) return null;
  if (existing.voidedAt !== null) throw conflict('This charge has already been voided.');

  const result = await db
    .update(charge)
    .set({ voidedAt: new Date(), voidedReason: data.reason, voidedByUserId: userId })
    .where(
      and(
        eq(charge.orgId, orgId),
        eq(charge.leaseId, leaseId),
        eq(charge.id, chargeId),
        isNull(charge.voidedAt),
      ),
    )
    .returning({ id: charge.id });
  if (result.length === 0) return null;

  return resolveCharge(orgId, db, leaseId, chargeId);
}

/**
 * Void the original, then insert a successor linked to it — never an edit. Ordered
 * VOID FIRST (PLAN-PHASE3A.md §4.4): a torn failure between the two statements
 * leaves a voided charge with no successor — a visible hole the landlord can refill
 * — rather than, if the order were reversed, a moment where both the original and
 * the successor are live at once, which is the double-bill a tenant could actually
 * be charged against.
 *
 * The successor always carries `source: 'manual'` and `generationKey: null` — never
 * the original's key, which still belongs to the voided row on the plain
 * `charge_generation_uq` index (PLAN-PHASE3A.md §7.2). Reusing it here would collide
 * with the original and the insert would be silently dropped by the very
 * `ON CONFLICT DO NOTHING` the generator relies on.
 */
export async function correctCharge(
  orgId: string,
  db: Database,
  leaseId: string,
  chargeId: string,
  userId: string,
  data: CorrectChargeBody,
): Promise<ChargeRow | null> {
  const existing = await resolveCharge(orgId, db, leaseId, chargeId);
  if (!existing) return null;
  if (existing.voidedAt !== null) throw conflict('This charge has already been voided.');

  const voided = await db
    .update(charge)
    .set({ voidedAt: new Date(), voidedReason: data.reason, voidedByUserId: userId })
    .where(
      and(
        eq(charge.orgId, orgId),
        eq(charge.leaseId, leaseId),
        eq(charge.id, chargeId),
        isNull(charge.voidedAt),
      ),
    )
    .returning({ id: charge.id });
  if (voided.length === 0) return null;

  const id = uuidv7();
  await db.insert(charge).values({
    id,
    orgId,
    leaseId,
    type: existing.type,
    periodStart: existing.periodStart,
    periodEnd: existing.periodEnd,
    periodIndex: existing.periodIndex,
    occupiedStart: existing.occupiedStart,
    occupiedEnd: existing.occupiedEnd,
    daysOccupied: existing.daysOccupied,
    daysInPeriod: existing.daysInPeriod,
    dueDate: data.dueDate ?? existing.dueDate,
    amountCents: data.amountCents,
    currency: existing.currency,
    description: data.description ?? existing.description,
    isProrated: existing.isProrated,
    source: 'manual',
    generationKey: null,
    supersedesChargeId: existing.id,
    createdByUserId: userId,
  });

  return resolveCharge(orgId, db, leaseId, id);
}

/* ======================================================================== *
 * the generator (PLAN-PHASE3A.md §4.1) — called by BOTH jobs/daily.ts and the
 * manual-kick route, never duplicated between them.
 * ======================================================================== */

/**
 * A structural PICK, not an import from `repo/lease.ts` — `LeaseRow` (lease.ts) and
 * `GeneratableLeaseRow` (repo/system/charges.ts) both satisfy this shape, and
 * neither needs to import the other's module for it to type-check.
 */
export interface GeneratableLease {
  id: string;
  currency: string;
  rentFrequency: RentFrequency;
  rentCents: number;
  billingDay: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  ledgerStartDate: IsoDate;
  moveOutDate: IsoDate | null;
  moveOutBillingPolicy: MoveOutBillingPolicy;
  calendar: CalendarSystem;
  depositCents: number;
  openingBalanceCents: number;
}

/**
 * The deposit and opening-balance charges — written ONCE each, keyed by the
 * contract's own `DEPOSIT_GENERATION_KEY`/`OPENING_BALANCE_GENERATION_KEY`
 * (collision with a period key is impossible by construction: a period key is
 * always `YYYY-MM-DD`). A ZERO amount writes NOTHING — a zero deposit or opening
 * balance is the absence of one, not an obligation (contrast a zero-amount RENT
 * charge, which genuinely exists and IS written — see `charge_amount_ck`'s comment
 * in schema.ts).
 */
function nonPeriodicRows(orgId: string, lease: GeneratableLease): (typeof charge.$inferInsert)[] {
  const rows: (typeof charge.$inferInsert)[] = [];

  if (lease.depositCents > 0) {
    rows.push({
      id: uuidv7(),
      orgId,
      leaseId: lease.id,
      type: 'deposit',
      periodStart: null,
      periodEnd: null,
      periodIndex: null,
      occupiedStart: null,
      occupiedEnd: null,
      daysOccupied: null,
      daysInPeriod: null,
      dueDate: lease.startDate,
      amountCents: lease.depositCents,
      currency: lease.currency,
      description: null,
      isProrated: false,
      source: 'generated',
      generationKey: DEPOSIT_GENERATION_KEY,
      supersedesChargeId: null,
      createdByUserId: null,
    });
  }

  if (lease.openingBalanceCents > 0) {
    rows.push({
      id: uuidv7(),
      orgId,
      leaseId: lease.id,
      type: 'opening_balance',
      periodStart: null,
      periodEnd: null,
      periodIndex: null,
      occupiedStart: null,
      occupiedEnd: null,
      daysOccupied: null,
      daysInPeriod: null,
      dueDate: lease.ledgerStartDate,
      amountCents: lease.openingBalanceCents,
      currency: lease.currency,
      description: null,
      isProrated: false,
      source: 'generated',
      generationKey: OPENING_BALANCE_GENERATION_KEY,
      supersedesChargeId: null,
      createdByUserId: null,
    });
  }

  return rows;
}

/**
 * THE generator. Never asks "what is due today" — it asks "which periods should
 * exist, and which of them are missing", and answers the second half with a unique
 * index rather than application logic.
 *
 * `today` is ALWAYS injected — this function never reads a clock (PLAN-PHASE3A.md
 * §5.1: the run instant is captured once, at the top of `jobs/daily.ts`, and passed
 * down. Every lease in a run must see the same clock).
 *
 * `plan` picks WHICH set of periods to write — `chargesDueForGeneration` (the
 * default, used by the cron and the ordinary manual kick) or
 * `chargesThroughNextPeriod` (the "bill one period early" manual action). Threaded
 * through rather than duplicated: the insert, the conflict target and the
 * non-periodic rows stay byte-identical for every caller, and only the function
 * that decides which periods are "due" varies.
 *
 * `rows.length === 0` is deliberately checked before the INSERT: `db.insert(...)
 * .values([])` is either a no-op or a SQL error depending on the driver, and a
 * lease with a zero deposit, a zero opening balance, and a schedule that is
 * entirely already-written hits exactly this path every single day it is
 * (uneventfully) re-scanned.
 *
 * `RETURNING` on `ON CONFLICT DO NOTHING` returns ONLY the rows actually inserted —
 * so `{ created: charge[] }` is honest without a second query, and idempotency is
 * the UNIQUE INDEX, never an application-level "have I already run today" flag.
 */
export async function generateChargesForLease(
  orgId: string,
  db: Database,
  lease: GeneratableLease,
  rentSteps: readonly RentStep[],
  today: IsoDate,
  plan: (terms: LeaseBillingTerms, today: IsoDate) => PlannedCharge[] = chargesDueForGeneration,
): Promise<ChargeRow[]> {
  const terms = billingTermsFor({ ...lease, rentSteps });
  const planned = plan(terms, today);

  const rows: (typeof charge.$inferInsert)[] = [
    ...nonPeriodicRows(orgId, lease),
    ...planned.map((p) => plannedChargeToInsert(orgId, lease, p)),
  ];
  if (rows.length === 0) return [];

  return db
    .insert(charge)
    .values(rows)
    .onConflictDoNothing({ target: [charge.leaseId, charge.generationKey] })
    .returning(chargeColumns());
}
