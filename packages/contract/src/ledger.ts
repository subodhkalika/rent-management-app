import { z } from 'zod';
import { money, moneyDelta, moneyTotal, currency, uuid, isoDate, type IsoDate } from './common.js';
import { charge, chargeOverdue, type Charge } from './charge.js';
import { payment, type Payment } from './payment.js';

/**
 * Which money settles which charge.
 *
 * Allocation is DERIVED, never stored. There is no allocation table and there must
 * not be one: a stored allocation can drift from the rows it describes, and nothing
 * can detect that it has.
 *
 * The server computes this in SQL — see `apps/api/src/db/repo/ledger.ts`. The
 * `allocateFifo` below is the same rule in TypeScript and the server never calls it.
 * It exists for two jobs: it is the oracle the SQL is tested against, so the two
 * cannot drift silently, and it is the browser's optimistic preview of what a payment
 * will clear. If they ever disagree, the SQL is right and the preview is stale.
 */

/* ---------- status ---------- */

export const chargeStatus = z.enum(['void', 'paid', 'partially_paid', 'overdue', 'unpaid']);
export type ChargeStatus = z.infer<typeof chargeStatus>;

export const chargeStatusLabels: Record<ChargeStatus, string> = {
  void: 'Void',
  paid: 'Paid',
  partially_paid: 'Part paid',
  overdue: 'Overdue',
  unpaid: 'Unpaid',
};

/**
 * Never a stored column — it is a question about today, and today moves.
 *
 * Order matters. `appliedCents >= amountCents` comes before the overdue check and
 * uses `>=` rather than `===` so a ZERO-amount charge is born paid. A prorated rent
 * can round to zero, and with these two tests the other way round such a charge would
 * read overdue forever — arrears no payment could ever clear.
 */
export function chargeStatusFor(input: {
  amountCents: number;
  appliedCents: number;
  dueDate: IsoDate;
  isVoided: boolean;
  /** `localToday(property.timezone)` — never the viewer's clock. */
  today: IsoDate;
}): ChargeStatus {
  if (input.isVoided) return 'void';
  if (input.appliedCents >= input.amountCents) return 'paid';
  if (input.appliedCents > 0) return 'partially_paid';
  if (chargeOverdue(input.dueDate, input.today)) return 'overdue';
  return 'unpaid';
}

/* ---------- allocation ---------- */

export interface AllocatableCharge {
  id: string;
  dueDate: IsoDate;
  amountCents: number;
  isVoided: boolean;
}

export interface AllocatablePayment {
  kind: 'payment' | 'refund';
  amountCents: number;
  isVoided: boolean;
}

export interface AllocationResult {
  id: string;
  appliedCents: number;
}

/**
 * FIFO by due date: the oldest debt settles first.
 *
 * Ordered by `(dueDate, id)`. Not by when a charge was created — a charge raised
 * today for last March must settle before this month's rent, or a back-billed
 * utility jumps the queue. Ids are UUIDv7, so the tiebreak is insertion order:
 * stable and total.
 *
 * Voided charges drop out of the queue entirely rather than being skipped in place,
 * so everything after them shifts up — that shift IS the implementation of "void a
 * charge and the money it consumed is freed". Voided payments drop out of the total,
 * so allocation retreats from the newest charges backwards, which is the
 * implementation of "the cheque bounced".
 */
export function allocateFifo(input: {
  charges: readonly AllocatableCharge[];
  payments: readonly AllocatablePayment[];
}): AllocationResult[] {
  const net = input.payments
    .filter((p) => !p.isVoided)
    .reduce((t, p) => t + (p.kind === 'payment' ? p.amountCents : -p.amountCents), 0);

  const live = input.charges
    .filter((c) => !c.isVoided)
    .slice()
    .sort((a, b) => (a.dueDate === b.dueDate ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
                                             : a.dueDate < b.dueDate ? -1 : 1));

  const out: AllocationResult[] = [];
  let prior = 0;
  for (const c of live) {
    // Exactly the SQL's GREATEST(0, LEAST(amount, net - prior)).
    out.push({ id: c.id, appliedCents: Math.max(0, Math.min(c.amountCents, net - prior)) });
    prior += c.amountCents;
  }
  // A voided charge still has to render, and it is never allocated anything.
  for (const c of input.charges) {
    if (c.isVoided) out.push({ id: c.id, appliedCents: 0 });
  }
  return out;
}

/* ---------- balances ---------- */

/**
 * `balanceCents === outstandingCents - creditCents`, always. That identity is the
 * point of these five numbers and it is asserted over every fixture.
 *
 * `outstanding` and `credit` are never both non-zero: money is applied greedily, so a
 * credit can only exist once every charge is saturated.
 */
export const chainBalance = z.object({
  chainId: uuid,
  currency,
  /** The property-local date the figures were computed against. */
  asOfDate: isoDate,
  chargedCents: moneyTotal,
  paidCents: moneyTotal,
  outstandingCents: moneyTotal,
  creditCents: moneyTotal,
  /** Signed — `money` is nonnegative and would reject every credit at the boundary. */
  balanceCents: moneyDelta,
  /** Past due, excluding deposits. What dunning uses. */
  arrearsCents: moneyTotal,
  depositOutstandingCents: moneyTotal,
  rentOutstandingCents: moneyTotal,
  /** Earliest due date still carrying a remainder — "three days late" vs "four months gone". */
  oldestOverdueDueDate: isoDate.nullable(),
});
export type ChainBalance = z.infer<typeof chainBalance>;

/**
 * One lease's slice of its tenancy.
 *
 * Deliberately carries no credit and no signed balance: a credit belongs to the
 * tenancy, not to one of its leases, and a signed per-lease figure would not sum to
 * the chain's — which is the phantom-credit problem chain-wide allocation exists to
 * abolish.
 */
export const leaseBalanceSlice = z.object({
  leaseId: uuid,
  outstandingCents: moneyTotal,
  arrearsCents: moneyTotal,
  depositOutstandingCents: moneyTotal,
  rentOutstandingCents: moneyTotal,
});
export type LeaseBalanceSlice = z.infer<typeof leaseBalanceSlice>;

export const leaseBalanceResponse = z.object({
  lease: leaseBalanceSlice,
  chain: chainBalance,
});
export type LeaseBalanceResponse = z.infer<typeof leaseBalanceResponse>;

/** Turns a signed balance into the two words a person reads. */
export function splitBalance(balanceCents: number): { owedCents: number; creditCents: number } {
  return balanceCents >= 0
    ? { owedCents: balanceCents, creditCents: 0 }
    : { owedCents: 0, creditCents: -balanceCents };
}

/* ---------- ledger ---------- */

export const allocatedCharge = charge.extend({
  appliedCents: moneyTotal,
  status: chargeStatus,
});
export type AllocatedCharge = z.infer<typeof allocatedCharge>;

/**
 * A discriminated union, not a flat row with half its fields null.
 *
 * Note that two different orderings live in one response and they do NOT agree
 * row-by-row: `appliedCents` is FIFO over charges by due date, while
 * `runningBalanceCents` is chronological over the merged stream. They answer
 * different questions. Do not "reconcile" them — that breaks FIFO.
 */
export const ledgerEntry = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('charge'),
    /** Which lease in the chain this belongs to — shown when a chain spans several. */
    leaseId: uuid,
    effectiveDate: isoDate,
    runningBalanceCents: moneyDelta,
    charge: allocatedCharge,
  }),
  z.object({
    kind: z.literal('payment'),
    leaseId: uuid,
    effectiveDate: isoDate,
    runningBalanceCents: moneyDelta,
    payment,
  }),
]);
export type LedgerEntry = z.infer<typeof ledgerEntry>;

export const LEDGER_MAX_ENTRIES = 1000;
export const ARREARS_MAX_ROWS = 500;

export const ledgerLease = z.object({
  leaseId: uuid,
  startDate: isoDate,
  endDate: isoDate.nullable(),
  /** True for the lease the chain is currently on. */
  isCurrent: z.boolean(),
});
export type LedgerLease = z.infer<typeof ledgerLease>;

export const ledgerResponse = z.object({
  chainId: uuid,
  currency,
  asOfDate: isoDate,
  /** Every lease in the chain, so the UI can name which one a row came from. */
  leases: z.array(ledgerLease),
  entries: z.array(ledgerEntry),
  balance: chainBalance,
  truncated: z.boolean(),
});
export type LedgerResponse = z.infer<typeof ledgerResponse>;

/* ---------- arrears ---------- */

export const arrearsRow = z.object({
  chainId: uuid,
  leaseId: uuid,
  propertyId: uuid,
  propertyName: z.string(),
  unitId: uuid,
  unitLabel: z.string(),
  primaryTenantName: z.string().nullable(),
  arrearsCents: moneyTotal,
  oldestOverdueDueDate: isoDate,
  daysLate: z.number().int().nonnegative(),
  /** False once every lease in the chain has ended — a departed tenant who still owes. */
  isCurrent: z.boolean(),
});
export type ArrearsRow = z.infer<typeof arrearsRow>;

/**
 * Grouped by currency at the top level rather than flat with a currency column, so
 * there is no shape in which a client can accidentally sum across currencies — no
 * array ever contains two of them.
 */
export const arrearsGroup = z.object({
  currency,
  chainCount: z.number().int().nonnegative(),
  totalArrearsCents: moneyTotal,
  rows: z.array(arrearsRow),
});
export type ArrearsGroup = z.infer<typeof arrearsGroup>;

export const arrearsResponse = z.object({
  asOfDate: isoDate,
  groups: z.array(arrearsGroup),
  truncated: z.boolean(),
});
export type ArrearsResponse = z.infer<typeof arrearsResponse>;

export const arrearsQuery = z.object({
  propertyId: uuid.optional(),
  currency: currency.optional(),
  /** Below this, a rounding remainder is not worth chasing. */
  minCents: z.coerce.number().int().min(1).default(1),
});
export type ArrearsQuery = z.infer<typeof arrearsQuery>;
