import type { AllocatableCharge, AllocatablePayment } from './ledger.js';

/**
 * The file that keeps the SQL and the spec from drifting.
 *
 * The API's integration test runs these as real rows through the real window
 * function and asserts the result equals `allocateFifo` over the same input. The
 * contract's own test asserts `allocateFifo` equals `expected` below. So a change to
 * either implementation that is not a change to the other fails loudly.
 */

export interface AllocationFixture {
  name: string;
  charges: AllocatableCharge[];
  payments: AllocatablePayment[];
  /** chargeId -> appliedCents */
  expected: Record<string, number>;
  /** `charged - paid`, the signed balance. This is the number of record. */
  expectedBalanceCents: number;
  /**
   * Set when `balanceCents === outstandingCents - creditCents` does NOT hold.
   *
   * That identity is true only while net payments are non-negative. Refund more than
   * was ever received and the balance keeps climbing, while `outstanding` cannot
   * exceed what was charged and `credit` is already zero — so they part company by
   * exactly the over-refunded amount. `balanceCents` stays right; `outstanding`
   * becomes an understatement.
   */
  identityBreaksBy?: number;
}

const c = (id: string, dueDate: string, amountCents: number, isVoided = false): AllocatableCharge =>
  ({ id, dueDate: dueDate as never, amountCents, isVoided });
const pay = (amountCents: number, isVoided = false): AllocatablePayment =>
  ({ kind: 'payment', amountCents, isVoided });
const refund = (amountCents: number): AllocatablePayment =>
  ({ kind: 'refund', amountCents, isVoided: false });

export const allocationFixtures: readonly AllocationFixture[] = [
  {
    name: 'A1 exact — one charge, one payment that clears it',
    charges: [c('a', '2026-01-01', 100000)],
    payments: [pay(100000)],
    expected: { a: 100000 },
    expectedBalanceCents: 0,
  },
  {
    name: 'A2 partial — the oldest charge takes what there is, the next gets nothing',
    charges: [c('a', '2026-01-01', 100000), c('b', '2026-02-01', 100000)],
    payments: [pay(60000)],
    expected: { a: 60000, b: 0 },
    expectedBalanceCents: 140000,
  },
  {
    name: 'A3 overpayment — every charge saturates and the rest is a credit',
    charges: [c('a', '2026-01-01', 100000)],
    payments: [pay(150000)],
    expected: { a: 100000 },
    expectedBalanceCents: -50000,
  },
  {
    name: 'A4 paid before the charge exists — the credit waits, and the charge is born paid',
    charges: [],
    payments: [pay(100000)],
    expected: {},
    expectedBalanceCents: -100000,
  },
  {
    name: 'A5 refund of an overpayment — the credit goes, no charge is touched',
    charges: [c('a', '2026-01-01', 100000)],
    payments: [pay(150000), refund(50000)],
    expected: { a: 100000 },
    expectedBalanceCents: 0,
  },
  {
    name: 'A6 bounced cheque — allocation retreats from the newest charge backwards',
    charges: [c('a', '2026-01-01', 100000), c('b', '2026-02-01', 100000)],
    payments: [pay(100000), pay(100000, true)],
    expected: { a: 100000, b: 0 },
    expectedBalanceCents: 100000,
  },
  {
    name: 'A7 voided charge mid-sequence — later charges shift up and take its money',
    charges: [c('a', '2026-01-01', 100000), c('b', '2026-02-01', 100000, true), c('d', '2026-03-01', 100000)],
    payments: [pay(200000)],
    // b is out of the queue entirely, so d sees prior = 100000, not 200000.
    expected: { a: 100000, b: 0, d: 100000 },
    expectedBalanceCents: 0,
  },
  {
    name: 'A8 correction chain — the voided original is out, its successor is in',
    charges: [c('a', '2026-01-01', 100000, true), c('b', '2026-01-01', 90000)],
    payments: [pay(90000)],
    expected: { a: 0, b: 90000 },
    expectedBalanceCents: 0,
  },
  {
    name: 'A9 THE FRAME TRAP — a deposit and a first rent sharing one due date',
    // Under Postgres's DEFAULT window frame these two are peers, so each sees the
    // other's amount in `prior` and a single payment double-applies. Verified against
    // a real database: the deposit reads prior = 30000 rather than 0. The explicit
    // ROWS frame is what makes this fixture pass, and this pairing is routine — a
    // deposit is due on the lease start date and so is the first rent when the
    // billing day is the period start.
    charges: [c('dep', '2026-01-01', 50000), c('rent', '2026-01-01', 30000)],
    payments: [pay(50000)],
    expected: { dep: 50000, rent: 0 },
    expectedBalanceCents: 30000,
  },
  {
    name: 'A10 ZERO-AMOUNT CHARGE — born paid, never overdue',
    // A prorated rent can round to nothing. If status checked overdue before paid,
    // this would read as permanent arrears that no payment could ever clear.
    charges: [c('zero', '2026-01-01', 0), c('a', '2026-02-01', 100000)],
    payments: [pay(100000)],
    expected: { zero: 0, a: 100000 },
    expectedBalanceCents: 0,
  },
  {
    name: 'A11 across a renewal — a payment on the new lease clears the old one first',
    charges: [c('old', '2026-01-01', 100000), c('new', '2026-04-01', 120000)],
    payments: [pay(100000)],
    expected: { old: 100000, new: 0 },
    expectedBalanceCents: 120000,
  },
  {
    name: 'A12 refund exceeding everything received — clamped, never negative applied',
    charges: [c('a', '2026-01-01', 100000)],
    payments: [pay(50000), refund(80000)],
    expected: { a: 0 },
    expectedBalanceCents: 130000,
    // Net paid is -30000, so outstanding (100000, capped at what was charged) and
    // credit (0) understate the balance by exactly the over-refund. The API refuses a
    // refund larger than net received, but VOIDING a payment after refunding it
    // reaches the same state with no guard in the way.
    identityBreaksBy: 30000,
  },
  {
    name: 'A13 nothing at all',
    charges: [],
    payments: [],
    expected: {},
    expectedBalanceCents: 0,
  },
  {
    name: 'A14 ordering is by due date, not by insertion — a back-billed charge settles first',
    charges: [c('recent', '2026-03-01', 50000), c('backbilled', '2026-01-15', 20000)],
    payments: [pay(20000)],
    expected: { backbilled: 20000, recent: 0 },
    expectedBalanceCents: 50000,
  },
];
