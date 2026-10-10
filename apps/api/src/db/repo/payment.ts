import { and, asc, eq, gte, lte, isNull, sql } from 'drizzle-orm';
import {
  uuidv7,
  localToday,
  compareIsoDate,
  type RecordPaymentBody,
  type VoidPaymentBody,
  type CorrectPaymentBody,
  type PaymentListQuery,
} from '@rms/contract';
import type { Database } from '../index.js';
import { payment, lease, unit, property } from '../schema.js';
import { conflict, validationFailed } from '../../lib/errors.js';
import { isCheckViolation } from '../../lib/db-errors.js';
import { decodeDueDateCursor } from '../../lib/pagination.js';
import { netPaidForChain } from './ledger.js';

/**
 * Money received, recorded by a person — never by the generator. Append-only:
 * `note` is the only mutable field; every other change is the void tombstone or
 * a superseding row (`supersedesPaymentId`), exactly the same two mechanisms
 * `charge.ts` uses. ORDINARY orgId-first repo, covered by `tenancy.guard.test.ts`.
 *
 * Allocation is NEVER decided here. Every repo function below writes or reads a
 * `payment` ROW; which charge a payment settles is derived fresh, every time,
 * by `repo/ledger.ts`'s window function — this file never allocates anything.
 */

export interface PaymentRow {
  id: string;
  leaseId: string;
  kind: (typeof payment.$inferSelect)['kind'];
  method: (typeof payment.$inferSelect)['method'];
  amountCents: number;
  currency: string;
  receivedOn: string;
  reference: string | null;
  note: string | null;
  supersedesPaymentId: string | null;
  voidedAt: Date | null;
  voidedReason: string | null;
  voidedByUserId: string | null;
  recordedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

function paymentColumns() {
  return {
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
    voidedByUserId: payment.voidedByUserId,
    recordedByUserId: payment.recordedByUserId,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
  };
}

/* ======================================================================== *
 * GET /v1/leases/:id/payments — lease-scoped list, paginated
 * ======================================================================== */

// Reuses the contract's (date, id) cursor shape `decodeDueDateCursor` already
// validates — same ordering key (`received_on, id`), same calendar-validity
// check on the date half. Named for charges there; the shape is generic.
export function listPaymentsQuery(orgId: string, db: Database, leaseId: string, opts: PaymentListQuery) {
  const conditions = [eq(payment.orgId, orgId), eq(payment.leaseId, leaseId)];
  if (!opts.includeVoided) conditions.push(isNull(payment.voidedAt));
  if (opts.from) conditions.push(gte(payment.receivedOn, opts.from));
  if (opts.to) conditions.push(lte(payment.receivedOn, opts.to));
  if (opts.kind) conditions.push(eq(payment.kind, opts.kind));
  if (opts.cursor) {
    const c = decodeDueDateCursor(opts.cursor);
    conditions.push(sql`(${payment.receivedOn}, ${payment.id}) > (${c.dueDate}::date, ${c.id}::uuid)`);
  }

  return db
    .select(paymentColumns())
    .from(payment)
    .where(and(...conditions))
    .orderBy(asc(payment.receivedOn), asc(payment.id))
    .limit(opts.limit + 1);
}

export async function listPayments(
  orgId: string,
  db: Database,
  leaseId: string,
  opts: PaymentListQuery,
): Promise<{ rows: PaymentRow[]; hasMore: boolean }> {
  const rows = await listPaymentsQuery(orgId, db, leaseId, opts);
  const hasMore = rows.length > opts.limit;
  return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
}

/* ======================================================================== *
 * resolve — (org_id, lease_id, id), same shape resolveCharge uses
 * ======================================================================== */

export function resolvePaymentQuery(orgId: string, db: Database, leaseId: string, paymentId: string) {
  return db
    .select(paymentColumns())
    .from(payment)
    .where(and(eq(payment.orgId, orgId), eq(payment.leaseId, leaseId), eq(payment.id, paymentId)))
    .limit(1);
}

export async function resolvePayment(
  orgId: string,
  db: Database,
  leaseId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  const [row] = await resolvePaymentQuery(orgId, db, leaseId, paymentId);
  return row ?? null;
}

/* ======================================================================== *
 * the lease a payment is recorded against — currency, chain, property tz
 * ======================================================================== */

interface PaymentLeaseContext {
  id: string;
  status: (typeof lease.$inferSelect)['status'];
  currency: string;
  chainId: string;
  propertyTimezone: string;
}

function resolveLeaseForPaymentQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select({
      id: lease.id,
      status: lease.status,
      currency: lease.currency,
      chainId: lease.chainId,
      propertyTimezone: property.timezone,
    })
    .from(lease)
    .innerJoin(unit, and(eq(unit.id, lease.unitId), eq(unit.orgId, orgId)))
    .innerJoin(property, and(eq(property.id, unit.propertyId), eq(property.orgId, orgId)))
    .where(and(eq(lease.orgId, orgId), eq(lease.id, leaseId), isNull(lease.deletedAt)))
    .limit(1);
}

async function resolveLeaseForPayment(
  orgId: string,
  db: Database,
  leaseId: string,
): Promise<PaymentLeaseContext | null> {
  const [row] = await resolveLeaseForPaymentQuery(orgId, db, leaseId);
  return row ?? null;
}

/**
 * `receivedOn` is the PROPERTY's local date, never the recorder's (PLAN-PHASE3B
 * .md §2.5). A payment received "tomorrow" is a typo and would silently inflate
 * a balance — rejected as 422, naming the field.
 */
function assertNotFutureDated(receivedOn: string, propertyTimezone: string): void {
  const today = localToday(propertyTimezone);
  if (compareIsoDate(receivedOn, today) > 0) {
    throw validationFailed({ receivedOn: ['receivedOn cannot be in the future.'] });
  }
}

/**
 * The one guard in 3b that is NOT derived (§4.14): a refund may never take the
 * chain's net-received below zero. Read-then-write, not race-safe — acceptable
 * (a landlord is one person at a time) and harmless if it loses, because the
 * allocation's own `GREATEST(0, …)` clamps regardless of what gets through here.
 */
async function assertRefundWithinNetReceived(
  orgId: string,
  db: Database,
  chainId: string,
  amountCents: number,
): Promise<void> {
  const netReceivedCents = await netPaidForChain(orgId, db, chainId);
  if (amountCents > netReceivedCents) {
    throw conflict('This refund is larger than everything ever received on this tenancy.');
  }
}

/**
 * DECISION (not in the plan — see this agent's final report): voiding is guarded
 * too, symmetrically. The plan's refund guard alone leaves a second path to the
 * exact same over-refunded state — fixture A12 documents it: refund right up to
 * the edge of net-received (guarded, passes), then VOID the original payment
 * that created the room for it. Nothing re-checks the total at void time, so
 * net-received goes negative anyway with no guard in the way.
 *
 * Voiding a 'payment' row can only ever REDUCE net-received, so it gets the same
 * check the refund guard runs. Voiding a 'refund' row can only ever INCREASE
 * net-received (undoing a refund hands the money back), which can never push it
 * negative — so it needs no guard, and none is applied.
 */
async function assertVoidKeepsNetReceivedNonNegative(
  orgId: string,
  db: Database,
  chainId: string,
  target: Pick<PaymentRow, 'kind' | 'amountCents'>,
): Promise<void> {
  if (target.kind !== 'payment') return;
  const netReceivedCents = await netPaidForChain(orgId, db, chainId);
  if (netReceivedCents - target.amountCents < 0) {
    throw conflict(
      "Voiding this payment would take this tenancy's net received below zero. Void the related refund first.",
    );
  }
}

/* ======================================================================== *
 * record / note / void / correct
 * ======================================================================== */

/**
 * Refuses a `draft`/`cancelled` lease (409) — the same shape `createManualCharge`
 * already uses for charges. `currency` and `chainId` are NEVER accepted from the
 * client; both are read off the resolved lease.
 */
export async function recordPayment(
  orgId: string,
  db: Database,
  leaseId: string,
  userId: string,
  data: RecordPaymentBody,
): Promise<PaymentRow | null> {
  const leaseRow = await resolveLeaseForPayment(orgId, db, leaseId);
  if (!leaseRow) return null;
  if (leaseRow.status === 'draft' || leaseRow.status === 'cancelled') {
    throw conflict('Payments cannot be recorded against a draft or cancelled lease.');
  }

  assertNotFutureDated(data.receivedOn, leaseRow.propertyTimezone);
  if (data.kind === 'refund') {
    await assertRefundWithinNetReceived(orgId, db, leaseRow.chainId, data.amountCents);
  }

  const id = uuidv7();
  try {
    await db.insert(payment).values({
      id,
      orgId,
      leaseId,
      kind: data.kind,
      method: data.method,
      amountCents: data.amountCents,
      currency: leaseRow.currency,
      receivedOn: data.receivedOn,
      reference: data.reference ?? null,
      note: data.note ?? null,
      supersedesPaymentId: null,
      recordedByUserId: userId,
    });
  } catch (err) {
    // payment_amount_ck is unreachable through the API (paymentAmountCents
    // already refines `> 0`) — this is the same belt-and-suspenders 3a left for
    // charge_amount_ck, closed now that db-errors.ts knows 23514.
    if (isCheckViolation(err)) throw validationFailed({ amountCents: ['Enter an amount greater than zero'] });
    throw err;
  }

  return resolvePayment(orgId, db, leaseId, id);
}

/** The only mutation `payment` accepts besides the void tombstone — `note` is
 *  private bookkeeping that never reaches a tenant portal response. */
export async function updatePaymentNote(
  orgId: string,
  db: Database,
  leaseId: string,
  paymentId: string,
  note: string | null,
): Promise<PaymentRow | null> {
  const existing = await resolvePayment(orgId, db, leaseId, paymentId);
  if (!existing) return null;

  await db
    .update(payment)
    .set({ note, updatedAt: new Date() })
    .where(and(eq(payment.orgId, orgId), eq(payment.leaseId, leaseId), eq(payment.id, paymentId)));

  return resolvePayment(orgId, db, leaseId, paymentId);
}

/**
 * "This never happened, or I recorded it wrong" — a bounced cheque. `WHERE
 * voided_at IS NULL` on the UPDATE makes "already voided" authoritative against
 * a concurrent double-void, same shape `voidCharge` already uses.
 */
export async function voidPayment(
  orgId: string,
  db: Database,
  leaseId: string,
  paymentId: string,
  userId: string,
  data: VoidPaymentBody,
): Promise<PaymentRow | null> {
  const existing = await resolvePayment(orgId, db, leaseId, paymentId);
  if (!existing) return null;
  if (existing.voidedAt !== null) throw conflict('This payment has already been voided.');

  const leaseRow = await resolveLeaseForPayment(orgId, db, leaseId);
  if (!leaseRow) return null;
  await assertVoidKeepsNetReceivedNonNegative(orgId, db, leaseRow.chainId, existing);

  const result = await db
    .update(payment)
    .set({ voidedAt: new Date(), voidedReason: data.reason, voidedByUserId: userId, updatedAt: new Date() })
    .where(
      and(
        eq(payment.orgId, orgId),
        eq(payment.leaseId, leaseId),
        eq(payment.id, paymentId),
        isNull(payment.voidedAt),
      ),
    )
    .returning({ id: payment.id });
  if (result.length === 0) return null;

  return resolvePayment(orgId, db, leaseId, paymentId);
}

/**
 * Void the original, then insert a successor linked to it — never an edit, and
 * void-first (3a's own ordering, §4.4): a torn write leaves a visible hole
 * rather than a moment where two live payments both count.
 */
export async function correctPayment(
  orgId: string,
  db: Database,
  leaseId: string,
  paymentId: string,
  userId: string,
  data: CorrectPaymentBody,
): Promise<PaymentRow | null> {
  const existing = await resolvePayment(orgId, db, leaseId, paymentId);
  if (!existing) return null;
  if (existing.voidedAt !== null) throw conflict('This payment has already been voided.');

  const leaseRow = await resolveLeaseForPayment(orgId, db, leaseId);
  if (!leaseRow) return null;
  await assertVoidKeepsNetReceivedNonNegative(orgId, db, leaseRow.chainId, existing);

  const voided = await db
    .update(payment)
    .set({ voidedAt: new Date(), voidedReason: data.reason, voidedByUserId: userId, updatedAt: new Date() })
    .where(
      and(
        eq(payment.orgId, orgId),
        eq(payment.leaseId, leaseId),
        eq(payment.id, paymentId),
        isNull(payment.voidedAt),
      ),
    )
    .returning({ id: payment.id });
  if (voided.length === 0) return null;

  assertNotFutureDated(data.receivedOn, leaseRow.propertyTimezone);
  if (data.kind === 'refund') {
    // Checked AFTER the void above — net-received already reflects it, so this
    // is exactly the total the successor would land against.
    await assertRefundWithinNetReceived(orgId, db, leaseRow.chainId, data.amountCents);
  }

  const id = uuidv7();
  try {
    await db.insert(payment).values({
      id,
      orgId,
      leaseId,
      kind: data.kind,
      method: data.method,
      amountCents: data.amountCents,
      currency: leaseRow.currency,
      receivedOn: data.receivedOn,
      reference: data.reference ?? null,
      note: data.note ?? null,
      supersedesPaymentId: existing.id,
      recordedByUserId: userId,
    });
  } catch (err) {
    if (isCheckViolation(err)) throw validationFailed({ amountCents: ['Enter an amount greater than zero'] });
    throw err;
  }

  return resolvePayment(orgId, db, leaseId, id);
}

/* ======================================================================== *
 * hardDeleteLease's zero-payment precondition (repo/lease.ts, §4.13)
 * ======================================================================== */

export function existsPaymentForLeaseQuery(orgId: string, db: Database, leaseId: string) {
  return db
    .select({ id: payment.id })
    .from(payment)
    .where(and(eq(payment.orgId, orgId), eq(payment.leaseId, leaseId)))
    .limit(1);
}

export async function existsPaymentForLease(orgId: string, db: Database, leaseId: string): Promise<boolean> {
  const [row] = await existsPaymentForLeaseQuery(orgId, db, leaseId);
  return row !== undefined;
}
