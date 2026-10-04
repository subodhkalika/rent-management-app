import { Hono } from 'hono';
import { updateUnitBody, type UpdateUnitBody } from '@rms/contract';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, parsedBody } from '../middleware/validate.js';
import { notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { mapUnit } from '../lib/mappers.js';
import * as unitRepo from '../db/repo/unit.js';
import type { AppBindings } from '../types.js';

export const units = new Hono<AppBindings>();

units.use('*', requireAuth);

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

  const ok = await unitRepo.softDeleteUnit(orgId, db, id);
  if (!ok) throw notFound('Unit');
  return c.body(null, 204);
});
