import { Hono } from 'hono';
import {
  recordPaymentBody,
  updatePaymentNoteBody,
  voidPaymentBody,
  correctPaymentBody,
  paymentListQuery,
  type RecordPaymentBody,
  type UpdatePaymentNoteBody,
  type VoidPaymentBody,
  type CorrectPaymentBody,
  type PaymentListQuery,
} from '@rms/contract';
import { validateBody, validateQuery, parsedBody, parsedQuery } from '../middleware/validate.js';
import { notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { encodeDueDateCursor } from '../lib/pagination.js';
import { mapPayment } from '../lib/mappers.js';
import * as paymentRepo from '../db/repo/payment.js';
import * as leaseRepo from '../db/repo/lease.js';
import type { AppBindings } from '../types.js';

/**
 * Landlord payment routes (PLAN-PHASE3B.md §8.1). Nested under the lease, same
 * shape `charges.ts` already uses for void/correct — one extra path segment,
 * zero ambiguity about whether a bare id was scoped.
 *
 * Allocation (which charge a payment settles) is NEVER decided here — these
 * routes only write and read `payment` ROWS. `/ledger`, `/balance` and
 * `/arrears` (routes/ledger.ts) are the only places that read the one window
 * function in `repo/ledger.ts`.
 */
export const payments = new Hono<AppBindings>();

// Auth is applied centrally in src/index.ts — see middleware/auth-layer.ts.

payments.get('/v1/leases/:id/payments', validateQuery(paymentListQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');
  const query = parsedQuery<PaymentListQuery>(c);

  // Resolved first so a nonexistent/foreign lease 404s rather than returning
  // an empty page — same shape GET /v1/leases/:id/charges already uses.
  const current = await leaseRepo.getLease(orgId, db, leaseId);
  if (!current) throw notFound('Lease');

  const { rows, hasMore } = await paymentRepo.listPayments(orgId, db, leaseId, query);
  const items = rows.map(mapPayment);
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeDueDateCursor(last.receivedOn, last.id) : null;
  return c.json({ items, nextCursor });
});

payments.post('/v1/leases/:id/payments', validateBody(recordPaymentBody), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');
  const body = parsedBody<RecordPaymentBody>(c);

  const created = await paymentRepo.recordPayment(orgId, db, leaseId, userId, body);
  if (!created) throw notFound('Lease');
  return c.json(mapPayment(created), 201);
});

payments.patch(
  '/v1/leases/:leaseId/payments/:paymentId',
  validateBody(updatePaymentNoteBody),
  async (c) => {
    const orgId = c.get('orgId');
    const db = c.get('db');
    const leaseId = requireUuidParam(c.req.param('leaseId'), 'Lease');
    const paymentId = requireUuidParam(c.req.param('paymentId'), 'Payment');
    const body = parsedBody<UpdatePaymentNoteBody>(c);

    const updated = await paymentRepo.updatePaymentNote(orgId, db, leaseId, paymentId, body.note);
    if (!updated) throw notFound('Payment');
    return c.json(mapPayment(updated));
  },
);

payments.post(
  '/v1/leases/:leaseId/payments/:paymentId/void',
  validateBody(voidPaymentBody),
  async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const db = c.get('db');
    const leaseId = requireUuidParam(c.req.param('leaseId'), 'Lease');
    const paymentId = requireUuidParam(c.req.param('paymentId'), 'Payment');
    const body = parsedBody<VoidPaymentBody>(c);

    const updated = await paymentRepo.voidPayment(orgId, db, leaseId, paymentId, userId, body);
    if (!updated) throw notFound('Payment');
    return c.json(mapPayment(updated));
  },
);

payments.post(
  '/v1/leases/:leaseId/payments/:paymentId/correct',
  validateBody(correctPaymentBody),
  async (c) => {
    const orgId = c.get('orgId');
    const userId = c.get('userId');
    const db = c.get('db');
    const leaseId = requireUuidParam(c.req.param('leaseId'), 'Lease');
    const paymentId = requireUuidParam(c.req.param('paymentId'), 'Payment');
    const body = parsedBody<CorrectPaymentBody>(c);

    const created = await paymentRepo.correctPayment(orgId, db, leaseId, paymentId, userId, body);
    if (!created) throw notFound('Payment');
    return c.json(mapPayment(created), 201);
  },
);
