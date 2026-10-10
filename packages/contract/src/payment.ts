import { z } from 'zod';
import { money, currency, uuid, pageQuery, isoDate } from './common.js';
import { queryBoolean } from './charge.js';

/**
 * Money received, as a record of an event that happened.
 *
 * Nothing automates a payment — a person recorded it — which is where every
 * difference from `charge` comes from.
 */

export const paymentKind = z.enum(['payment', 'refund']);
export type PaymentKind = z.infer<typeof paymentKind>;

export const paymentMethod = z.enum([
  'bank_transfer', 'cash', 'cheque', 'card_external', 'upi', 'other',
]);
export type PaymentMethod = z.infer<typeof paymentMethod>;

export const paymentMethodLabels: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  card_external: 'Card (outside this app)',
  upi: 'UPI',
  other: 'Other',
};

/**
 * Strictly positive, unlike a charge amount.
 *
 * A charge may legitimately be zero — a prorated rent can round to nothing and the
 * generator must be able to write that period. Nothing generates a payment, so a
 * zero is a mis-click. Refunds are stored positive too and signed at read; a negative
 * sitting in a money column is a landmine for every later SUM.
 */
export const paymentAmountCents = money.refine((v) => v > 0, 'Enter an amount greater than zero');

/* ---------- responses ---------- */

export const payment = z.object({
  id: uuid,
  leaseId: uuid,
  kind: paymentKind,
  method: paymentMethod,
  amountCents: money,
  currency,
  /** The PROPERTY's local date, not the recorder's. */
  receivedOn: isoDate,
  /** Immutable — it is evidence. */
  reference: z.string().nullable(),
  /** The only mutable field, and private: it never reaches a tenant. */
  note: z.string().nullable(),
  supersedesPaymentId: uuid.nullable(),
  voidedAt: z.string().datetime().nullable(),
  voidedReason: z.string().nullable(),
  /** Never null: a person recorded this. */
  recordedByUserId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Payment = z.infer<typeof payment>;

/* ---------- requests ---------- */

/**
 * No `currency` — the server copies the lease's, so a mismatch is unrepresentable
 * rather than validated. No `chargeId` either: earmarking money to a specific charge
 * would end FIFO's claim to be the single definition of what is paid.
 */
export const recordPaymentBody = z.object({
  kind: paymentKind.default('payment'),
  method: paymentMethod,
  amountCents: paymentAmountCents,
  receivedOn: isoDate,
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});
export type RecordPaymentBody = z.infer<typeof recordPaymentBody>;

export const voidPaymentBody = z.object({
  reason: z.string().trim().min(10, 'Say why in a sentence').max(500),
});
export type VoidPaymentBody = z.infer<typeof voidPaymentBody>;

export const correctPaymentBody = recordPaymentBody.extend({
  reason: z.string().trim().min(10, 'Say why in a sentence').max(500),
});
export type CorrectPaymentBody = z.infer<typeof correctPaymentBody>;

/** `.strict()` so a stray `amountCents` is a 422 rather than a silent no-op. */
export const updatePaymentNoteBody = z
  .object({ note: z.string().trim().max(2000).nullable() })
  .strict();
export type UpdatePaymentNoteBody = z.infer<typeof updatePaymentNoteBody>;

export const paymentListQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
  kind: paymentKind.optional(),
  includeVoided: queryBoolean.default(true),
});
export type PaymentListQuery = z.infer<typeof paymentListQuery>;
