import { Hono } from 'hono';
import { updateUnitBody, type UpdateUnitBody } from '@rms/contract';
import { validateBody, parsedBody } from '../middleware/validate.js';
import { conflict, notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { mapUnit } from '../lib/mappers.js';
import * as unitRepo from '../db/repo/unit.js';
import * as leaseRepo from '../db/repo/lease.js';
import type { AppBindings } from '../types.js';

export const units = new Hono<AppBindings>();

// Auth is applied centrally in src/index.ts — see the auth layering table there.
// A `.use('*')` here would leak onto every route in the app, not just this router's.

units.get('/v1/units/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Unit');

  const row = await unitRepo.getUnit(orgId, db, id);
  if (!row) throw notFound('Unit');
  return c.json(mapUnit(row));
});

units.patch('/v1/units/:id', validateBody(updateUnitBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Unit');
  const body = parsedBody<UpdateUnitBody>(c);

  const updated = await unitRepo.updateUnit(orgId, db, id, body);
  if (!updated) throw notFound('Unit');
  return c.json(mapUnit(updated));
});

units.delete('/v1/units/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Unit');

  // docs/PLAN-PHASE2.md §3.6: 409 while the unit has an active lease.
  const activeLeaseCount = await leaseRepo.countActiveLeasesForUnit(orgId, db, id);
  if (activeLeaseCount > 0) {
    throw conflict('This unit has an active lease. End the lease before deleting the unit.');
  }

  const ok = await unitRepo.softDeleteUnit(orgId, db, id);
  if (!ok) throw notFound('Unit');
  return c.body(null, 204);
});
