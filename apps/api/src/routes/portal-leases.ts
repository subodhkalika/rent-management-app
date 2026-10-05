import { Hono } from 'hono';
import {
  scheduleQuery,
  billingTermsFor,
  buildSchedule,
  compareIsoDate,
  calendarForSystem,
  type ScheduleQuery,
  type PortalLeaseSchedule,
} from '@rms/contract';
import { validateQuery, parsedQuery } from '../middleware/validate.js';
import { notFound, validationFailed } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { mapPortalLease, mapPortalLeaseDetail } from '../lib/mappers.js';
import * as portalLeaseRepo from '../db/repo/portal/lease.js';
import type { AppBindings } from '../types.js';

/**
 * Tenant-facing lease routes. §4.2's routing footgun: `routes.portal.profile` is
 * `/v1/portal/:tenantId/profile`, so `/v1/portal/leases/:id` would otherwise be
 * captured as `tenantId = "leases"`. Registered here, in its OWN router, and
 * mounted in index.ts BEFORE `portal` — Hono matches registration order, so this
 * router's literal `/v1/portal/leases...` paths are tried first. No change to
 * middleware/auth-layer.ts is needed: its existing `under(path, '/v1/portal')`
 * branch already routes every path under here through `requireTenant`.
 */
export const portalLeases = new Hono<AppBindings>();

portalLeases.get('/v1/portal/leases', async (c) => {
  const scope = c.get('tenantScope');
  const db = c.get('db');

  const rows = await portalLeaseRepo.listLeases(scope, db);
  return c.json({ items: rows.map(mapPortalLease) });
});

portalLeases.get('/v1/portal/leases/:id', async (c) => {
  const scope = c.get('tenantScope');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');

  const row = await portalLeaseRepo.resolveLease(scope, db, id);
  if (!row) throw notFound('Lease');
  return c.json(mapPortalLeaseDetail(row));
});

portalLeases.get('/v1/portal/leases/:id/schedule', validateQuery(scheduleQuery), async (c) => {
  const scope = c.get('tenantScope');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Lease');
  const query = parsedQuery<ScheduleQuery>(c);

  // resolveLease FIRST, and 404 before billing.ts is ever reached — the schedule
  // is built only from the resolved row's own columns, so nothing from the
  // request survives into the computation except the lease id just verified.
  const row = await portalLeaseRepo.resolveLease(scope, db, id);
  if (!row) throw notFound('Lease');

  const calendar = calendarForSystem(row.calendar);
  const maxThrough = calendar.addYears(row.startDate, 10);
  if (compareIsoDate(query.through, maxThrough) > 0) {
    throw validationFailed({ through: ['through must be within 10 years of startDate'] });
  }

  const terms = billingTermsFor(row);

  let periods;
  try {
    periods = buildSchedule(terms, query.through);
  } catch (err) {
    if (err instanceof RangeError) {
      throw validationFailed({ through: ['This date range produces too many billing periods'] });
    }
    throw err;
  }

  const response: PortalLeaseSchedule = {
    leaseId: row.id,
    currency: row.currency as PortalLeaseSchedule['currency'],
    computedThrough: query.through,
    periods,
  };
  return c.json(response);
});
