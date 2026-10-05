import { Hono } from 'hono';
import {
  createPropertyBody,
  updatePropertyBody,
  createUnitBody,
  pageQuery,
  type CreatePropertyBody,
  type UpdatePropertyBody,
  type CreateUnitBody,
  type PageQuery,
} from '@rms/contract';
import { validateBody, validateQuery, parsedBody, parsedQuery } from '../middleware/validate.js';
import { conflict, notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { encodeCursor } from '../lib/pagination.js';
import { mapProperty, mapUnit } from '../lib/mappers.js';
import * as propertyRepo from '../db/repo/property.js';
import * as unitRepo from '../db/repo/unit.js';
import * as leaseRepo from '../db/repo/lease.js';
import type { AppBindings } from '../types.js';

export const properties = new Hono<AppBindings>();

// Auth is applied centrally in src/index.ts — see the auth layering table there.
// A `.use('*')` here would leak onto every route in the app, not just this router's.

properties.get('/v1/properties', validateQuery(pageQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const query = parsedQuery<PageQuery>(c);

  const { rows, hasMore } = await propertyRepo.listProperties(orgId, db, query);
  const items = rows.map(mapProperty);
  const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1]!.id) : null;
  return c.json({ items, nextCursor });
});

properties.post('/v1/properties', validateBody(createPropertyBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const body = parsedBody<CreatePropertyBody>(c);

  const created = await propertyRepo.createProperty(orgId, db, body);
  return c.json(mapProperty(created), 201);
});

properties.get('/v1/properties/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Property');

  const row = await propertyRepo.getProperty(orgId, db, id);
  if (!row) throw notFound('Property');
  return c.json(mapProperty(row));
});

properties.patch('/v1/properties/:id', validateBody(updatePropertyBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Property');
  const body = parsedBody<UpdatePropertyBody>(c);

  const updated = await propertyRepo.updateProperty(orgId, db, id, body);
  if (!updated) throw notFound('Property');
  return c.json(mapProperty(updated));
});

properties.delete('/v1/properties/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Property');

  // docs/PLAN-PHASE2.md §3.6: 409 while ANY unit under this property has an
  // active lease.
  const activeLeaseCount = await leaseRepo.countActiveLeasesForProperty(orgId, db, id);
  if (activeLeaseCount > 0) {
    throw conflict('A unit under this property has an active lease. End the lease before deleting the property.');
  }

  const ok = await propertyRepo.softDeleteProperty(orgId, db, id);
  if (!ok) throw notFound('Property');
  return c.body(null, 204);
});

/* ---------- units nested under a property ---------- */

properties.get('/v1/properties/:propertyId/units', validateQuery(pageQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const propertyId = requireUuidParam(c.req.param('propertyId'), 'Property');

  // 404 on a missing/foreign property rather than silently returning an empty list.
  const parent = await propertyRepo.getProperty(orgId, db, propertyId);
  if (!parent) throw notFound('Property');

  const query = parsedQuery<PageQuery>(c);
  const { rows, hasMore } = await unitRepo.listUnits(orgId, db, propertyId, query);
  const items = rows.map(mapUnit);
  const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1]!.id) : null;
  return c.json({ items, nextCursor });
});

properties.post('/v1/properties/:propertyId/units', validateBody(createUnitBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const propertyId = requireUuidParam(c.req.param('propertyId'), 'Property');

  const parent = await propertyRepo.getProperty(orgId, db, propertyId);
  if (!parent) throw notFound('Property');

  const body = parsedBody<CreateUnitBody>(c);
  const created = await unitRepo.createUnit(orgId, db, propertyId, body);
  return c.json(mapUnit(created), 201);
});
