import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  compareIsoDate,
  chargeOverdue,
  daysBetweenInclusive,
  localToday,
  type IsoDate,
} from '@rms/contract';
import type { Database } from '../index.js';
import { lease, charge, payment, unit, property, tenant, leaseTenant } from '../schema.js';
import { conflict } from '../../lib/errors.js';
import { chargeColumns, type ChargeRow } from './charge.js';

/**
 * THE one window function (PLAN-PHASE3B.md §3). `allocatedCharges` below is the
 * single, derived definition of "what has been paid against which charge" —
 * the ledger, the balance and the arrears view are all built from its output,
 * and nothing else in this app is allowed to decide that number a second way.
 *
 * `allocateFifo` in `packages/contract/src/ledger.ts` restates the SAME rule in
 * TypeScript. The server never calls it — it exists only as the test oracle
 * (`allocation.integration.test.ts` asserts this file's SQL output against it,
 * field by field) and the browser's optimistic preview. If they ever disagree,
 * THIS file is right and the preview is stale.
 *
 * Allocation is CHAIN-wide, never lease-wide: the partition key in every window
 * below is `chain_id`, not `lease_id`. A renewal is the same tenancy under a new
 * rent, and money paid on lease B must be able to settle a shortfall left on a
 * dead lease A — see §3.1. `renewLease` (repo/lease.ts) is what makes a chain
 * mean "one tenancy" by construction: it refuses a renewal sharing no tenant
 * with its predecessor, which is the one assumption every number in this file
 * rests on.
 */

/* ======================================================================== *
 * scoped leases — one chain, or (opts.chainId omitted) the whole org
 * ======================================================================== */

export interface ScopedLeaseRow {
  id: string;
  chainId: string;
  currency: string;
  startDate: IsoDate;
  endDate: IsoDate | null;
  status: (typeof lease.$inferSelect)['status'];
}

export function scopedLeasesQuery(orgId: string, db: Database, opts: { chainId?: string } = {}) {
  const conditions = [eq(lease.orgId, orgId), isNull(lease.deletedAt)];
  if (opts.chainId) conditions.push(eq(lease.chainId, opts.chainId));
  return db
    .select({
      id: lease.id,
      chainId: lease.chainId,
      currency: lease.currency,
      startDate: lease.startDate,
      endDate: lease.endDate,
      status: lease.status,
    })
    .from(lease)
    .where(and(...conditions))
    .orderBy(asc(lease.startDate));
}

export async function scopedLeases(
  orgId: string,
  db: Database,
  opts: { chainId?: string } = {},
): Promise<ScopedLeaseRow[]> {
  return scopedLeasesQuery(orgId, db, opts);
}

/**
 * Belt-and-braces on top of `renewLease`'s own 409 (PLAN-PHASE3B.md §6.2): a
 * chain that somehow spans two currencies must never be summed. A loud,
 * specific failure beats a plausible wrong total.
 */
function assertSingleCurrency(leases: readonly { currency: string }[]): string {
  const currencies = new Set(leases.map((l) => l.currency));
  if (currencies.size > 1) {
    throw conflict('This tenancy spans more than one currency — refusing to sum across them.');
  }
  return leases[0]!.currency;
}

/* ======================================================================== *
 * net paid per chain — payments minus refunds, live only
 * ======================================================================== */

export interface NetPaidRow {
  chainId: string;
  totalCents: number;
}

/**
 * `SUM(bigint)` returns `numeric`, which the Neon HTTP driver hands back as a
 * STRING — cast `::bigint` in SQL (§3.3 correction 4) AND `Number()` here. Never
 * skip either half: the cast alone does not change what the driver returns.
 */
export async function netPaidByChain(
  orgId: string,
  db: Database,
  opts: { chainId?: string } = {},
): Promise<NetPaidRow[]> {
  const scopedLease = db.$with('scoped_lease').as(
    db
      .select({ id: lease.id, chainId: lease.chainId })
      .from(lease)
      .where(
        opts.chainId
          ? and(eq(lease.orgId, orgId), eq(lease.chainId, opts.chainId))
          : eq(lease.orgId, orgId),
      ),
  );

  const rows = await db
    .with(scopedLease)
    .select({
      chainId: scopedLease.chainId,
      totalCents: sql<string>`coalesce(sum(case when ${payment.kind} = 'payment' then ${payment.amountCents} else -${payment.amountCents} end), 0)::bigint`.as(
        'total_cents',
      ),
    })
    .from(scopedLease)
    .innerJoin(
      payment,
      and(eq(payment.leaseId, scopedLease.id), eq(payment.orgId, orgId), isNull(payment.voidedAt)),
    )
    .groupBy(scopedLease.chainId);

  return rows.map((r) => ({ chainId: r.chainId, totalCents: Number(r.totalCents) }));
}

export async function netPaidForChain(orgId: string, db: Database, chainId: string): Promise<number> {
  const rows = await netPaidByChain(orgId, db, { chainId });
  return rows[0]?.totalCents ?? 0;
}

/* ======================================================================== *
 * allocatedCharges — THE window function (§3.2), parameterised by scope
 * ======================================================================== */

export interface AllocatedChargeRow extends ChargeRow {
  chainId: string;
  appliedCents: number;
  // The owning PROPERTY's timezone — "overdue" is decided there, never at the
  // server's own clock (same rule `listChargesForOrgQuery`'s `overdueOnly`
  // already follows). Carried per-row because `orgArrears` spans many
  // properties, possibly many timezones, in one call — a single shared
  // "asOfDate" would be wrong for a Sydney charge and an LA charge evaluated at
  // the same instant near either's local midnight.
  propertyTimezone: string;
}

/**
 * Every charge in scope — voided or not. A voided charge is never allocated
 * anything (forced to 0 here, never computed) but still needs to render in the
 * ledger, struck through (§3.4) — the caller decides whether to keep or drop it,
 * this function always returns both.
 *
 * `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` — NEVER the default `RANGE`
 * frame. Postgres's default groups PEERS sharing one `ORDER BY` value, so a
 * deposit and a same-day first rent would each see the OTHER's amount in `prior`
 * and a single payment would double-apply. Verified against this very database
 * (see the SQL sanity check run before writing this): the default frame gives
 * the deposit `prior = 30000` instead of `0`. This single clause is the most
 * load-bearing token in this file — `allocation.integration.test.ts` pins it
 * with a fixture (A9) that is asserted to FAIL if this is ever reverted to the
 * default frame.
 */
export async function allocatedCharges(
  orgId: string,
  db: Database,
  opts: { chainId?: string } = {},
): Promise<AllocatedChargeRow[]> {
  const scopedLease = db.$with('scoped_lease').as(
    db
      .select({ id: lease.id, chainId: lease.chainId, propertyTimezone: property.timezone })
      .from(lease)
      .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
      .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
      .where(
        opts.chainId
          ? and(eq(lease.orgId, orgId), eq(lease.chainId, opts.chainId))
          : eq(lease.orgId, orgId),
      ),
  );

  const netPaid = db.$with('net_paid').as(
    db
      .select({
        chainId: scopedLease.chainId,
        totalCents: sql<string>`coalesce(sum(case when ${payment.kind} = 'payment' then ${payment.amountCents} else -${payment.amountCents} end), 0)::bigint`.as(
          'total_cents',
        ),
      })
      .from(scopedLease)
      .innerJoin(
        payment,
        and(eq(payment.leaseId, scopedLease.id), eq(payment.orgId, orgId), isNull(payment.voidedAt)),
      )
      .groupBy(scopedLease.chainId),
  );

  // LIVE charges only — a voided charge drops out of the partition entirely, so
  // everything after it shifts up and takes its money (§3.4: "void a charge and
  // the money it consumed is freed"). Ordered by (due_date, id), never
  // created_at — a charge raised today for a period last March must settle
  // before this month's rent.
  const ordered = db.$with('ordered').as(
    db
      .select({
        id: charge.id,
        priorCents: sql<string>`coalesce(sum(${charge.amountCents}) over (
          partition by ${scopedLease.chainId}
          order by ${charge.dueDate}, ${charge.id}
          rows between unbounded preceding and 1 preceding
        ), 0)::bigint`.as('prior_cents'),
      })
      .from(charge)
      .innerJoin(scopedLease, eq(scopedLease.id, charge.leaseId))
      .where(and(eq(charge.orgId, orgId), isNull(charge.voidedAt))),
  );

  // The outer select is a LEFT JOIN from EVERY charge (live or voided) onto
  // `ordered` — a voided charge has no match there, so its applied amount is
  // forced to 0 by the CASE rather than computed from a (necessarily absent)
  // `prior_cents`. `org_id` is independently asserted on `lease`, `payment` AND
  // `charge` (three separate conjuncts above and below) — a forged `chainId`
  // from another org matches zero leases and the whole query returns empty.
  const rows = await db
    .with(scopedLease, netPaid, ordered)
    .select({
      ...chargeColumns(),
      chainId: scopedLease.chainId,
      propertyTimezone: scopedLease.propertyTimezone,
      appliedCents: sql<string>`case when ${charge.voidedAt} is not null then 0::bigint
        else greatest(0::bigint, least(${charge.amountCents}, coalesce(${netPaid.totalCents}, 0::bigint) - coalesce(${ordered.priorCents}, 0::bigint))) end`.as(
        'applied_cents',
      ),
    })
    .from(charge)
    .innerJoin(scopedLease, eq(scopedLease.id, charge.leaseId))
    .leftJoin(ordered, eq(ordered.id, charge.id))
    .leftJoin(netPaid, eq(netPaid.chainId, scopedLease.chainId))
    .where(eq(charge.orgId, orgId))
    .orderBy(asc(charge.dueDate), asc(charge.id));

  return rows.map((r) => ({
    ...r,
    appliedCents: Number(r.appliedCents),
  }));
}

/* ======================================================================== *
 * balances (§5) — chain-wide numbers, plus one lease's slice of them
 * ======================================================================== */

export interface ChainBalanceResult {
  chainId: string;
  currency: string;
  asOfDate: IsoDate;
  chargedCents: number;
  paidCents: number;
  outstandingCents: number;
  creditCents: number;
  balanceCents: number;
  arrearsCents: number;
  depositOutstandingCents: number;
  rentOutstandingCents: number;
  oldestOverdueDueDate: IsoDate | null;
}

export interface LeaseBalanceSliceResult {
  leaseId: string;
  outstandingCents: number;
  arrearsCents: number;
  depositOutstandingCents: number;
  rentOutstandingCents: number;
}

/**
 * Pure arithmetic over already-allocated rows — NOT a second allocation rule.
 * `appliedCents` on every row already came out of the one window function
 * above; summing those numbers per bucket is bookkeeping, not FIFO.
 */
export function buildChainBalance(
  chainId: string,
  currency: string,
  asOfDate: IsoDate,
  paidCents: number,
  charges: readonly AllocatedChargeRow[],
): ChainBalanceResult {
  let chargedCents = 0;
  let outstandingCents = 0;
  let depositOutstandingCents = 0;
  let arrearsCents = 0;
  let oldestOverdueDueDate: IsoDate | null = null;

  for (const c of charges) {
    if (c.voidedAt !== null) continue;
    chargedCents += c.amountCents;
    const remainder = c.amountCents - c.appliedCents;
    outstandingCents += remainder;
    if (c.type === 'deposit') {
      depositOutstandingCents += remainder;
      continue;
    }
    // §6.1: arrears excludes not-yet-due rent and excludes deposits entirely.
    // "Overdue" is decided in the owning PROPERTY's own timezone, never the
    // caller-supplied `asOfDate` alone — within one chain every charge shares
    // one property, so this agrees with `asOfDate` by construction, and using
    // the per-row rule uniformly is "one rule, not two" (§6.1).
    if (remainder > 0 && chargeOverdue(c.dueDate, localToday(c.propertyTimezone))) {
      arrearsCents += remainder;
      if (oldestOverdueDueDate === null || compareIsoDate(c.dueDate, oldestOverdueDueDate) < 0) {
        oldestOverdueDueDate = c.dueDate;
      }
    }
  }

  return {
    chainId,
    currency,
    asOfDate,
    chargedCents,
    paidCents,
    outstandingCents,
    creditCents: Math.max(0, paidCents - chargedCents),
    balanceCents: chargedCents - paidCents,
    arrearsCents,
    depositOutstandingCents,
    rentOutstandingCents: outstandingCents - depositOutstandingCents,
    oldestOverdueDueDate,
  };
}

/** One lease's restriction of the chain's own allocation — never a re-allocation.
 *  No credit, no signed balance (§5.3): a credit belongs to the tenancy, not to
 *  one of its leases. */
export function buildLeaseBalanceSlice(
  leaseId: string,
  charges: readonly AllocatedChargeRow[],
): LeaseBalanceSliceResult {
  let outstandingCents = 0;
  let depositOutstandingCents = 0;
  let arrearsCents = 0;

  for (const c of charges) {
    if (c.voidedAt !== null || c.leaseId !== leaseId) continue;
    const remainder = c.amountCents - c.appliedCents;
    outstandingCents += remainder;
    if (c.type === 'deposit') {
      depositOutstandingCents += remainder;
      continue;
    }
    if (remainder > 0 && chargeOverdue(c.dueDate, localToday(c.propertyTimezone))) {
      arrearsCents += remainder;
    }
  }

  return {
    leaseId,
    outstandingCents,
    arrearsCents,
    depositOutstandingCents,
    rentOutstandingCents: outstandingCents - depositOutstandingCents,
  };
}

export async function chainBalance(
  orgId: string,
  db: Database,
  chainId: string,
  asOfDate: IsoDate,
): Promise<ChainBalanceResult | null> {
  const leases = await scopedLeases(orgId, db, { chainId });
  if (leases.length === 0) return null;
  const currency = assertSingleCurrency(leases);

  const [paidCents, charges] = await Promise.all([
    netPaidForChain(orgId, db, chainId),
    allocatedCharges(orgId, db, { chainId }),
  ]);

  return buildChainBalance(chainId, currency, asOfDate, paidCents, charges);
}

export interface LeaseAndChainBalance {
  lease: LeaseBalanceSliceResult;
  chain: ChainBalanceResult;
}

/**
 * `GET /v1/leases/:id/balance` — both slices in one response (§5.3), so a
 * landlord looking at lease B is never surprised by lease A's own debt.
 */
export async function leaseAndChainBalance(
  orgId: string,
  db: Database,
  leaseId: string,
  asOfDate: IsoDate,
): Promise<LeaseAndChainBalance | null> {
  const [row] = await db
    .select({ id: lease.id, chainId: lease.chainId })
    .from(lease)
    .where(and(eq(lease.orgId, orgId), eq(lease.id, leaseId), isNull(lease.deletedAt)))
    .limit(1);
  if (!row) return null;

  const leases = await scopedLeases(orgId, db, { chainId: row.chainId });
  const currency = assertSingleCurrency(leases);

  const [paidCents, charges] = await Promise.all([
    netPaidForChain(orgId, db, row.chainId),
    allocatedCharges(orgId, db, { chainId: row.chainId }),
  ]);

  return {
    lease: buildLeaseBalanceSlice(leaseId, charges),
    chain: buildChainBalance(row.chainId, currency, asOfDate, paidCents, charges),
  };
}

/* ======================================================================== *
 * the ledger — the whole chain, interleaved, running balance (§8.1)
 * ======================================================================== */

export interface ChainPaymentRow {
  id: string;
  leaseId: string;
  kind: (typeof payment.$inferSelect)['kind'];
  method: (typeof payment.$inferSelect)['method'];
  amountCents: number;
  currency: string;
  receivedOn: IsoDate;
  reference: string | null;
  note: string | null;
  supersedesPaymentId: string | null;
  voidedAt: Date | null;
  voidedReason: string | null;
  recordedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function listPaymentsForChain(
  orgId: string,
  db: Database,
  chainId: string,
  opts: { includeVoided: boolean },
): Promise<ChainPaymentRow[]> {
  const scopedLease = db.$with('scoped_lease').as(
    db
      .select({ id: lease.id })
      .from(lease)
      .where(and(eq(lease.orgId, orgId), eq(lease.chainId, chainId))),
  );

  const conditions = [eq(payment.orgId, orgId)];
  if (!opts.includeVoided) conditions.push(isNull(payment.voidedAt));

  return db
    .with(scopedLease)
    .select({
      id: payment.id,
      leaseId: payment.leaseId,
      kind: payment.kind,
      method: payment.method,
      amountCents: payment.amountCents,
      currency: payment.currency,
      receivedOn: payment.receivedOn,
      reference: payment.reference,
      note: payment.note,
      supersedesPaymentId: payment.supersedesPaymentId,
      voidedAt: payment.voidedAt,
      voidedReason: payment.voidedReason,
      recordedByUserId: payment.recordedByUserId,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    })
    .from(payment)
    .innerJoin(scopedLease, eq(scopedLease.id, payment.leaseId))
    .where(and(...conditions))
    .orderBy(asc(payment.receivedOn), asc(payment.id));
}

export interface LedgerLeaseRow {
  leaseId: string;
  startDate: IsoDate;
  endDate: IsoDate | null;
  isCurrent: boolean;
}

/** Ascending by startDate; `isCurrent` marks the lease with the LATEST startDate
 *  — the chain's current lease (§8.1's `leases` array; §6.1's "which lease an
 *  arrears row displays" rule, restated here for the ledger). */
export function buildLedgerLeases(leases: readonly ScopedLeaseRow[]): LedgerLeaseRow[] {
  if (leases.length === 0) return [];
  let currentStart = leases[0]!.startDate;
  for (const l of leases) {
    if (compareIsoDate(l.startDate, currentStart) > 0) currentStart = l.startDate;
  }
  return leases.map((l) => ({
    leaseId: l.id,
    startDate: l.startDate,
    endDate: l.endDate,
    isCurrent: compareIsoDate(l.startDate, currentStart) === 0,
  }));
}

export interface LedgerChargeEntry {
  kind: 'charge';
  leaseId: string;
  effectiveDate: IsoDate;
  charge: AllocatedChargeRow;
}

export interface LedgerPaymentEntry {
  kind: 'payment';
  leaseId: string;
  effectiveDate: IsoDate;
  payment: ChainPaymentRow;
}

export type RawLedgerEntry =
  | (LedgerChargeEntry & { runningBalanceCents: number })
  | (LedgerPaymentEntry & { runningBalanceCents: number });

/**
 * Interleaves charges and payments by EFFECTIVE date (`due_date` for a charge,
 * `received_on` for a payment) and walks a running balance chronologically.
 *
 * This ordering is NOT the same as `appliedCents` above, and the two will not
 * agree row-by-row — `appliedCents` is FIFO by due date; `runningBalanceCents`
 * is chronological over the merged stream. They answer different questions
 * (PLAN-PHASE3B.md §8.1's own warning). A voided row contributes 0 to the
 * running balance (it is struck through, not dropped — `includeVoided` already
 * decided whether it is in this list at all).
 */
export function buildRunningLedger(
  charges: readonly AllocatedChargeRow[],
  payments: readonly ChainPaymentRow[],
): RawLedgerEntry[] {
  const chargeEntries: LedgerChargeEntry[] = charges.map((c) => ({
    kind: 'charge',
    leaseId: c.leaseId,
    effectiveDate: c.dueDate,
    charge: c,
  }));
  const paymentEntries: LedgerPaymentEntry[] = payments.map((p) => ({
    kind: 'payment',
    leaseId: p.leaseId,
    effectiveDate: p.receivedOn,
    payment: p,
  }));

  const merged = [...chargeEntries, ...paymentEntries].sort((a, b) => {
    const byDate = compareIsoDate(a.effectiveDate, b.effectiveDate);
    if (byDate !== 0) return byDate;
    const aId = a.kind === 'charge' ? a.charge.id : a.payment.id;
    const bId = b.kind === 'charge' ? b.charge.id : b.payment.id;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  let running = 0;
  return merged.map((entry) => {
    if (entry.kind === 'charge') {
      if (entry.charge.voidedAt === null) running += entry.charge.amountCents;
    } else {
      if (entry.payment.voidedAt === null) {
        running += entry.payment.kind === 'payment' ? -entry.payment.amountCents : entry.payment.amountCents;
      }
    }
    return { ...entry, runningBalanceCents: running };
  });
}

export interface LeaseLedgerData {
  chainId: string;
  currency: string;
  asOfDate: IsoDate;
  leases: LedgerLeaseRow[];
  entries: RawLedgerEntry[];
  balance: ChainBalanceResult;
}

export async function leaseLedger(
  orgId: string,
  db: Database,
  leaseId: string,
  asOfDate: IsoDate,
  opts: { includeVoided: boolean },
): Promise<LeaseLedgerData | null> {
  const [row] = await db
    .select({ id: lease.id, chainId: lease.chainId })
    .from(lease)
    .where(and(eq(lease.orgId, orgId), eq(lease.id, leaseId), isNull(lease.deletedAt)))
    .limit(1);
  if (!row) return null;

  const leases = await scopedLeases(orgId, db, { chainId: row.chainId });
  const currency = assertSingleCurrency(leases);

  const [paidCents, allCharges, allPayments] = await Promise.all([
    netPaidForChain(orgId, db, row.chainId),
    allocatedCharges(orgId, db, { chainId: row.chainId }),
    listPaymentsForChain(orgId, db, row.chainId, opts),
  ]);

  const charges = opts.includeVoided ? allCharges : allCharges.filter((c) => c.voidedAt === null);
  const balance = buildChainBalance(row.chainId, currency, asOfDate, paidCents, allCharges);
  const entries = buildRunningLedger(charges, allPayments);

  return {
    chainId: row.chainId,
    currency,
    asOfDate,
    leases: buildLedgerLeases(leases),
    entries,
    balance,
  };
}

/* ======================================================================== *
 * arrears (§6) — org-wide, grouped by currency
 * ======================================================================== */

export interface ArrearsChainRow {
  chainId: string;
  leaseId: string;
  currency: string;
  propertyId: string;
  propertyName: string;
  unitId: string;
  unitLabel: string;
  primaryTenantName: string | null;
  arrearsCents: number;
  oldestOverdueDueDate: IsoDate;
  daysLate: number;
  isCurrent: boolean;
}

/** Property/unit/primary-tenant display info for a SET of (already-resolved)
 *  current-lease ids — one query for every arrears row, never N+1. Same
 *  correlated-subquery shape `repo/lease.ts`'s `primaryTenantNameColumn` uses. */
function arrearsDisplayInfoQuery(
  orgId: string,
  db: Database,
  leaseIds: readonly string[],
  propertyId?: string,
) {
  const conditions = [eq(lease.orgId, orgId), inArray(lease.id, [...leaseIds])];
  if (propertyId) conditions.push(eq(unit.propertyId, propertyId));

  return db
    .select({
      leaseId: lease.id,
      propertyId: property.id,
      propertyName: property.name,
      unitId: unit.id,
      unitLabel: unit.label,
      primaryTenantName: sql<string | null>`(
        select ${tenant.firstName} || ' ' || ${tenant.lastName}
        from ${leaseTenant}
        inner join ${tenant} on ${tenant.id} = ${leaseTenant.tenantId}
        where ${leaseTenant.leaseId} = ${lease.id}
          and ${leaseTenant.orgId} = ${orgId}
          and ${leaseTenant.isPrimary} = true
          and ${leaseTenant.removedOn} is null
        limit 1
      )`,
    })
    .from(lease)
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
    .where(and(...conditions));
}

export interface ArrearsOptions {
  propertyId?: string;
  currency?: string;
  minCents: number;
}

export const ARREARS_MAX_ROWS = 500;

export async function orgArrears(
  orgId: string,
  db: Database,
  opts: ArrearsOptions,
): Promise<{ rows: ArrearsChainRow[]; truncated: boolean }> {
  const leases = await scopedLeases(orgId, db, {});
  if (leases.length === 0) return { rows: [], truncated: false };

  const charges = await allocatedCharges(orgId, db, {});

  const leasesByChain = new Map<string, ScopedLeaseRow[]>();
  for (const l of leases) {
    const bucket = leasesByChain.get(l.chainId);
    if (bucket) bucket.push(l);
    else leasesByChain.set(l.chainId, [l]);
  }

  // §6.1: live, non-deposit charges whose due_date is already past. Grouped by
  // chain here in TypeScript — pure arithmetic over rows the ONE window function
  // above already produced, not a second allocation rule. At the stated scale
  // (tens of landlords, hundreds of leases) this is a few thousand rows, exactly
  // what §6.3 budgets for.
  //
  // "Overdue" (and the `daysLate` below) is per-ROW, in that charge's own
  // property's timezone — never a single date shared across the whole org.
  // This call spans every chain in the org at once, which can mean many
  // properties and many timezones at the same instant; a single shared date
  // would be wrong for a Sydney charge and an LA charge evaluated near either's
  // local midnight. Same rule `listChargesForOrgQuery`'s `overdueOnly` already
  // follows — "one rule, not two" (§6.1). Every charge in one chain shares one
  // property, so `propertyTimezone` here is the same for every row that landed
  // in a given chain's bucket.
  const arrearsByChain = new Map<
    string,
    { arrearsCents: number; oldestOverdueDueDate: IsoDate; propertyTimezone: string }
  >();
  for (const c of charges) {
    if (c.voidedAt !== null || c.type === 'deposit') continue;
    const remainder = c.amountCents - c.appliedCents;
    if (remainder <= 0 || !chargeOverdue(c.dueDate, localToday(c.propertyTimezone))) continue;
    const existing = arrearsByChain.get(c.chainId);
    if (!existing) {
      arrearsByChain.set(c.chainId, {
        arrearsCents: remainder,
        oldestOverdueDueDate: c.dueDate,
        propertyTimezone: c.propertyTimezone,
      });
    } else {
      existing.arrearsCents += remainder;
      if (compareIsoDate(c.dueDate, existing.oldestOverdueDueDate) < 0) existing.oldestOverdueDueDate = c.dueDate;
    }
  }

  interface Candidate {
    chainId: string;
    currentLeaseId: string;
    currency: string;
    isCurrent: boolean;
    arrearsCents: number;
    oldestOverdueDueDate: IsoDate;
    propertyTimezone: string;
  }

  const candidates: Candidate[] = [];
  for (const [chainId, chainLeases] of leasesByChain) {
    const arrears = arrearsByChain.get(chainId);
    if (!arrears || arrears.arrearsCents < opts.minCents) continue;

    const currency = assertSingleCurrency(chainLeases);
    if (opts.currency && currency !== opts.currency) continue;

    let current = chainLeases[0]!;
    for (const l of chainLeases) if (compareIsoDate(l.startDate, current.startDate) > 0) current = l;

    candidates.push({
      chainId,
      currentLeaseId: current.id,
      currency,
      // §6.1: "false once every lease in the chain has ended" — a departed
      // tenant who still owes money still appears, just not as current.
      isCurrent: chainLeases.some((l) => l.status === 'active'),
      arrearsCents: arrears.arrearsCents,
      oldestOverdueDueDate: arrears.oldestOverdueDueDate,
      propertyTimezone: arrears.propertyTimezone,
    });
  }

  // Worst (oldest) first — the column Phase 4's reminder scan sorts by (§6.1).
  candidates.sort((a, b) => compareIsoDate(a.oldestOverdueDueDate, b.oldestOverdueDueDate));

  const truncated = candidates.length > ARREARS_MAX_ROWS;
  const limited = truncated ? candidates.slice(0, ARREARS_MAX_ROWS) : candidates;

  const leaseIds = limited.map((c) => c.currentLeaseId);
  const display = leaseIds.length > 0 ? await arrearsDisplayInfoQuery(orgId, db, leaseIds, opts.propertyId) : [];
  const displayByLeaseId = new Map(display.map((d) => [d.leaseId, d]));

  const rows: ArrearsChainRow[] = [];
  for (const cand of limited) {
    const info = displayByLeaseId.get(cand.currentLeaseId);
    // Absent only when `opts.propertyId` excluded this chain's current lease —
    // the row belongs to a different property and is correctly dropped, not an
    // inconsistency.
    if (!info) continue;
    rows.push({
      chainId: cand.chainId,
      leaseId: cand.currentLeaseId,
      currency: cand.currency,
      propertyId: info.propertyId,
      propertyName: info.propertyName,
      unitId: info.unitId,
      unitLabel: info.unitLabel,
      primaryTenantName: info.primaryTenantName,
      arrearsCents: cand.arrearsCents,
      oldestOverdueDueDate: cand.oldestOverdueDueDate,
      daysLate: Math.max(
        0,
        daysBetweenInclusive(cand.oldestOverdueDueDate, localToday(cand.propertyTimezone)) - 1,
      ),
      isCurrent: cand.isCurrent,
    });
  }

  return { rows, truncated };
}
