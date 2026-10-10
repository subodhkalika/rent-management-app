import { allocateFifo, type AllocatableCharge, type AllocatablePayment, type ChargeType, type IsoDate, type PaymentKind } from '@rms/contract';

/**
 * The optimistic preview in the record-payment dialog — "this clears March and
 * $200 of April" — before the round trip.
 *
 * Built on `allocateFifo`, the contract's reference FIFO implementation
 * (docs/PLAN-PHASE3B.md §3.6): the server's SQL is the source of truth and this is
 * the browser's best guess from data already on the page. If they ever disagree,
 * the SQL is right and this preview is stale — never the other way round.
 *
 * Deliberately NOT scoped to one lease: the charges and payments passed in should
 * be the WHOLE CHAIN's (the ledger response already is), because allocation is
 * chain-wide (§3.1) — a lease-scoped preview would mis-predict the very case this
 * feature exists to explain, a payment on one lease clearing another's shortfall.
 */

export interface PreviewCharge extends AllocatableCharge {
  type: ChargeType;
  dueDate: IsoDate;
}

export interface AllocationDelta {
  chargeId: string;
  beforeAppliedCents: number;
  afterAppliedCents: number;
}

/** One row per LIVE charge passed in — `beforeAppliedCents` is the allocation
 *  without the new payment, `afterAppliedCents` is the allocation with it appended.
 *  A voided charge is included (as `allocateFifo` itself always reports one for a
 *  voided row) with both sides pinned to 0. */
export function computeAllocationDelta(input: {
  charges: readonly PreviewCharge[];
  existingPayments: readonly AllocatablePayment[];
  newPayment: { kind: PaymentKind; amountCents: number };
}): AllocationDelta[] {
  const before = allocateFifo({ charges: input.charges, payments: input.existingPayments });
  const after = allocateFifo({
    charges: input.charges,
    payments: [...input.existingPayments, { kind: input.newPayment.kind, amountCents: input.newPayment.amountCents, isVoided: false }],
  });
  const beforeMap = new Map(before.map((r) => [r.id, r.appliedCents]));
  const afterMap = new Map(after.map((r) => [r.id, r.appliedCents]));
  return input.charges.map((c) => ({
    chargeId: c.id,
    beforeAppliedCents: beforeMap.get(c.id) ?? 0,
    afterAppliedCents: afterMap.get(c.id) ?? 0,
  }));
}

export interface PreviewClearedCharge {
  chargeId: string;
  type: ChargeType;
  dueDate: IsoDate;
  amountCents: number;
  /** Positive: this payment newly covers this much of the charge. Negative: this
   *  payment (typically a refund) re-opens this much of a charge that was
   *  previously covered. */
  deltaCents: number;
}

/**
 * The charges a hypothetical payment would touch, ascending by due date — the
 * rows the dialog actually renders. Charges whose allocation would not change are
 * omitted; a payment that lands entirely as a new credit touches none at all.
 */
export function previewPaymentAllocation(input: {
  charges: readonly PreviewCharge[];
  existingPayments: readonly AllocatablePayment[];
  newPayment: { kind: PaymentKind; amountCents: number };
}): PreviewClearedCharge[] {
  const deltas = computeAllocationDelta(input);
  const deltaById = new Map(deltas.map((d) => [d.chargeId, d.afterAppliedCents - d.beforeAppliedCents]));
  const byId = new Map(input.charges.map((c) => [c.id, c]));

  return deltas
    .map((d) => {
      const charge = byId.get(d.chargeId);
      const delta = deltaById.get(d.chargeId) ?? 0;
      return charge && delta !== 0
        ? { chargeId: charge.id, type: charge.type, dueDate: charge.dueDate, amountCents: charge.amountCents, deltaCents: delta }
        : null;
    })
    .filter((row): row is PreviewClearedCharge => row !== null)
    .sort((a, b) => (a.dueDate === b.dueDate ? (a.chargeId < b.chargeId ? -1 : 1) : a.dueDate < b.dueDate ? -1 : 1));
}

/** The resulting credit/overpayment this hypothetical payment would leave, after
 *  every charge is saturated — `undefined` when nothing is left over. Mirrors
 *  `creditCents` server-side: `GREATEST(0, paid - charged)`, scoped to the same
 *  charges and payments the preview used. */
export function previewResultingCreditCents(input: {
  charges: readonly PreviewCharge[];
  existingPayments: readonly AllocatablePayment[];
  newPayment: { kind: PaymentKind; amountCents: number };
}): number {
  const charged = input.charges.filter((c) => !c.isVoided).reduce((t, c) => t + c.amountCents, 0);
  const existingNet = input.existingPayments
    .filter((p) => !p.isVoided)
    .reduce((t, p) => t + (p.kind === 'payment' ? p.amountCents : -p.amountCents), 0);
  const newNet = input.newPayment.kind === 'payment' ? input.newPayment.amountCents : -input.newPayment.amountCents;
  const paid = existingNet + newNet;
  return Math.max(0, paid - charged);
}
