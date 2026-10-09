import { Hono } from 'hono';
import {
  createChargeBody,
  voidChargeBody,
  correctChargeBody,
  chargeListQuery,
  orgChargeListQuery,
  localToday,
  chargesThroughNextPeriod,
  type CreateChargeBody,
  type VoidChargeBody,
  type CorrectChargeBody,
  type ChargeListQuery,
  type OrgChargeListQuery,
} from '@rms/contract';
import { validateBody, validateQuery, parsedBody, parsedQuery } from '../middleware/validate.js';
import { conflict, notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { encodeDueDateCursor } from '../lib/pagination.js';
import { mapCharge, mapChargeWithLease } from '../lib/mappers.js';
import * as chargeRepo from '../db/repo/charge.js';
import * as leaseRepo from '../db/repo/lease.js';
import type { AppBindings } from '../types.js';

export const charges = new Hono<AppBindings>();

// Auth is applied centrally in src/index.ts — see middleware/auth-layer.ts.

charges.get('/v1/leases/:id/charges', validateQuery(chargeListQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');
  const query = parsedQuery<ChargeListQuery>(c);

  const current = await leaseRepo.getLease(orgId, db, leaseId);
  if (!current) throw notFound('Lease');

  const { rows, hasMore } = await chargeRepo.listCharges(orgId, db, leaseId, query);
  const items = rows.map(mapCharge);
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeDueDateCursor(last.dueDate, last.id) : null;
  return c.json({ items, nextCursor });
});

/**
 * Manual charges: `late_fee | utility | other | deposit`. `rent` is structurally
 * absent from `createChargeBody.type` — the generator owns it, so a manual `rent`
 * charge competing for a generation key is rejected at the schema boundary, never
 * reached here.
 */
charges.post('/v1/leases/:id/charges', validateBody(createChargeBody), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');
  const body = parsedBody<CreateChargeBody>(c);

  const created = await chargeRepo.createManualCharge(orgId, db, leaseId, userId, body);
  if (!created) throw notFound('Lease');
  return c.json(mapCharge(created), 201);
});

/**
 * Takes NO `through` (PLAN-PHASE3A.md §9.1's correction to PLAN-V1): if a caller
 * chose the horizon, the written row set would stop being a function of `(terms,
 * today)` alone. This is exactly the cron's own work for one lease, run
 * synchronously on request — `generateChargesForLease` is the identical function
 * `jobs/daily.ts` calls.
 */
charges.post('/v1/leases/:id/charges/generate', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');

  const current = await leaseRepo.getLease(orgId, db, leaseId);
  if (!current) throw notFound('Lease');
  if (current.status === 'draft' || current.status === 'cancelled') {
    throw conflict('Charges cannot be generated for a draft or cancelled lease.');
  }

  const rentSteps = leaseRepo.toRentSteps(await leaseRepo.listRentSteps(orgId, db, leaseId));
  const today = localToday(current.propertyTimezone);
  const created = await chargeRepo.generateChargesForLease(orgId, db, current, rentSteps, today);
  return c.json({ created: created.map(mapCharge) });
});

/**
 * The landlord's deliberate "bill one period early" action — a tenant turns up
 * wanting to pay next period's rent before the scheduled run would create it.
 * Same guards, same shape, same response as `/generate`; the only difference is
 * `chargesThroughNextPeriod` instead of `chargesDueForGeneration` as the plan
 * function, threaded through the one shared `generateChargesForLease`. Repeating
 * this call writes nothing new, and once the scheduled run reaches the real period
 * start the generation key is already taken.
 */
charges.post('/v1/leases/:id/charges/generate-next-period', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');

  const current = await leaseRepo.getLease(orgId, db, leaseId);
  if (!current) throw notFound('Lease');
  if (current.status === 'draft' || current.status === 'cancelled') {
    throw conflict('Charges cannot be generated for a draft or cancelled lease.');
  }

  const rentSteps = leaseRepo.toRentSteps(await leaseRepo.listRentSteps(orgId, db, leaseId));
  const today = localToday(current.propertyTimezone);
  const created = await chargeRepo.generateChargesForLease(
    orgId,
    db,
    current,
    rentSteps,
    today,
    chargesThroughNextPeriod,
  );
  return c.json({ created: created.map(mapCharge) });
});

/**
 * Nested under the lease, not `/v1/charges/:id/void` (PLAN-PHASE3A.md §9.1
 * correction 1): the resolve is then `(org_id, lease_id, id)`, the same shape
 * `correctRentStep` already uses for `stepId` — one extra path segment, zero
 * ambiguity about whether a bare id was scoped.
 */
charges.post('/v1/leases/:leaseId/charges/:chargeId/void', validateBody(voidChargeBody), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('leaseId'), 'Lease');
  const chargeId = requireUuidParam(c.req.param('chargeId'), 'Charge');
  const body = parsedBody<VoidChargeBody>(c);

  const updated = await chargeRepo.voidCharge(orgId, db, leaseId, chargeId, userId, body);
  if (!updated) throw notFound('Charge');
  return c.json(mapCharge(updated));
});

charges.post('/v1/leases/:leaseId/charges/:chargeId/correct', validateBody(correctChargeBody), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('leaseId'), 'Lease');
  const chargeId = requireUuidParam(c.req.param('chargeId'), 'Charge');
  const body = parsedBody<CorrectChargeBody>(c);

  const created = await chargeRepo.correctCharge(orgId, db, leaseId, chargeId, userId, body);
  if (!created) throw notFound('Charge');
  return c.json(mapCharge(created), 201);
});

charges.get('/v1/charges', validateQuery(orgChargeListQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const query = parsedQuery<OrgChargeListQuery>(c);

  const { rows, hasMore } = await chargeRepo.listChargesForOrg(orgId, db, query);
  const items = rows.map(mapChargeWithLease);
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeDueDateCursor(last.dueDate, last.id) : null;
  return c.json({ items, nextCursor });
});
