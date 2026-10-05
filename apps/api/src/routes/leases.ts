import { Hono } from 'hono';
import {
  createLeaseBody,
  updateLeaseBody,
  endLeaseBody,
  renewLeaseBody,
  cancelLeaseBody,
  addLeaseTenantBody,
  removeLeaseTenantBody,
  leaseListQuery,
  scheduleQuery,
  billingTermsFor,
  compareIsoDate,
  type CreateLeaseBody,
  type UpdateLeaseBody,
  type EndLeaseBody,
  type RenewLeaseBody,
  type AddLeaseTenantBody,
  type RemoveLeaseTenantBody,
  type LeaseListQuery,
  type ScheduleQuery,
  type LeaseSchedule,
} from '@rms/contract';
import { validateBody, validateQuery, parsedBody, parsedQuery } from '../middleware/validate.js';
import { conflict, notFound, validationFailed } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { encodeCursor } from '../lib/pagination.js';
import { mapLeaseSummary, mapLeaseDetail, mapLeaseTenant } from '../lib/mappers.js';
import { scheduleSanityMaxThrough, buildScheduleOrThrow } from '../lib/schedule.js';
import * as leaseRepo from '../db/repo/lease.js';
import type { AppBindings } from '../types.js';

export const leases = new Hono<AppBindings>();

// Auth is applied centrally in src/index.ts — see the auth layering table there.
// A `.use('*')` here would leak onto every route in the app, not just this router's.

leases.get('/v1/leases', validateQuery(leaseListQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const query = parsedQuery<LeaseListQuery>(c);

  const { rows, hasMore } = await leaseRepo.listLeases(orgId, db, query);
  const items = rows.map(mapLeaseSummary);
  const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1]!.id) : null;
  return c.json({ items, nextCursor });
});

leases.post('/v1/leases', validateBody(createLeaseBody), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('db');
  const body = parsedBody<CreateLeaseBody>(c);

  const created = await leaseRepo.createLease(orgId, db, userId, body);
  return c.json(mapLeaseSummary(created), 201);
});

leases.get('/v1/leases/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');

  const row = await leaseRepo.getLeaseDetail(orgId, db, id);
  if (!row) throw notFound('Lease');
  return c.json(mapLeaseDetail(row));
});

leases.patch('/v1/leases/:id', validateBody(updateLeaseBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const body = parsedBody<UpdateLeaseBody>(c);

  const updated = await leaseRepo.updateLease(orgId, db, id, body);
  if (!updated) throw notFound('Lease');
  return c.json(mapLeaseSummary(updated));
});

leases.post('/v1/leases/:id/activate', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');

  const updated = await leaseRepo.activateLease(orgId, db, id);
  if (!updated) throw notFound('Lease');
  return c.json(mapLeaseSummary(updated));
});

leases.post('/v1/leases/:id/cancel', validateBody(cancelLeaseBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  // `reason` is validated by `cancelLeaseBody` but has no column to land in (no
  // field in §3.2's schema for it) — accepted, not persisted server-side.

  const updated = await leaseRepo.cancelLease(orgId, db, id);
  if (!updated) throw notFound('Lease');
  return c.json(mapLeaseSummary(updated));
});

leases.post('/v1/leases/:id/end', validateBody(endLeaseBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const body = parsedBody<EndLeaseBody>(c);

  const updated = await leaseRepo.endLease(orgId, db, id, body);
  if (!updated) throw notFound('Lease');
  return c.json(mapLeaseSummary(updated));
});

leases.post('/v1/leases/:id/renew', validateBody(renewLeaseBody), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const body = parsedBody<RenewLeaseBody>(c);

  const created = await leaseRepo.renewLease(orgId, db, userId, id, body);
  if (!created) throw notFound('Lease');
  return c.json(mapLeaseSummary(created), 201);
});

leases.delete('/v1/leases/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');

  const result = await leaseRepo.hardDeleteLease(orgId, db, id);
  if (result === false) throw notFound('Lease');
  if (result === 'blocked') {
    throw conflict('Leases that have been active are kept for the record. End the lease instead.');
  }
  return c.body(null, 204);
});

leases.get('/v1/leases/:id/schedule', validateQuery(scheduleQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const query = parsedQuery<ScheduleQuery>(c);

  const row = await leaseRepo.getLease(orgId, db, id);
  if (!row) throw notFound('Lease');

  // Keeps buildSchedule's MAX_SCHEDULE_PERIODS RangeError unreachable in practice
  // (packages/contract's billing.ts §1.5). This bound is an INPUT SANITY check,
  // not a billing computation — lib/schedule.ts's scheduleSanityMaxThrough is pure
  // day-count arithmetic (never a calendar's addYears), so it can never throw
  // regardless of the property's calendar.
  const maxThrough = scheduleSanityMaxThrough(row.startDate);
  if (compareIsoDate(query.through, maxThrough) > 0) {
    throw validationFailed({ through: ['through must be within 10 years of startDate'] });
  }

  // THE one sanctioned way to build billing terms (packages/contract's lease.ts) —
  // both this route and the portal's equivalent, and the browser's live preview,
  // call this and pass the result straight to buildSchedule. No local date
  // arithmetic anywhere in this file.
  const terms = billingTermsFor(row);

  // buildScheduleOrThrow turns a Bikram Sambat lease running past the calendar's
  // data table into a 422 naming the real limit, never a 500 (lib/schedule.ts).
  const periods = buildScheduleOrThrow(terms, query.through);

  const response: LeaseSchedule = {
    leaseId: row.id,
    currency: row.currency as LeaseSchedule['currency'],
    computedThrough: query.through,
    periods,
  };
  return c.json(response);
});

leases.post('/v1/leases/:id/tenants', validateBody(addLeaseTenantBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const body = parsedBody<AddLeaseTenantBody>(c);

  const created = await leaseRepo.addLeaseTenant(orgId, db, id, body);
  if (!created) throw notFound('Lease');
  return c.json(mapLeaseTenant(created), 201);
});

leases.post('/v1/leases/:id/tenants/:tenantId/remove', validateBody(removeLeaseTenantBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const tenantId = requireUuidParam(c.req.param('tenantId'), 'Tenant');
  const body = parsedBody<RemoveLeaseTenantBody>(c);

  const updated = await leaseRepo.removeLeaseTenant(orgId, db, id, tenantId, body);
  if (!updated) throw notFound('Tenant');
  return c.json(mapLeaseTenant(updated));
});

leases.post('/v1/leases/:id/tenants/:tenantId/primary', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const tenantId = requireUuidParam(c.req.param('tenantId'), 'Tenant');

  const updated = await leaseRepo.setPrimaryTenant(orgId, db, id, tenantId);
  if (!updated) throw notFound('Tenant');
  return c.json(mapLeaseTenant(updated));
});
