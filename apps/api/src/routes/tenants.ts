import { Hono } from 'hono';
import {
  createTenantBody,
  updateTenantBody,
  pageQuery,
  type CreateTenantBody,
  type UpdateTenantBody,
  type PageQuery,
  type InviteCreated,
} from '@rms/contract';
import { validateBody, validateQuery, parsedBody, parsedQuery } from '../middleware/validate.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { encodeCursor } from '../lib/pagination.js';
import { mapTenant } from '../lib/mappers.js';
import { generateInviteToken, sha256Hex } from '../lib/tokens.js';
import { sendEmail, renderInviteEmail } from '../lib/email.js';
import { getOrganizationName } from '../db/repo/auth/organization.js';
import * as tenantRepo from '../db/repo/tenant.js';
import * as leaseRepo from '../db/repo/lease.js';
import type { AppBindings } from '../types.js';

export const tenants = new Hono<AppBindings>();

// Auth is applied centrally in src/index.ts — see the auth layering table there.
// A `.use('*')` here would leak onto every route in the app, not just this router's.

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — docs/PLAN-V1.md §1.3

tenants.get('/v1/tenants', validateQuery(pageQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const query = parsedQuery<PageQuery>(c);

  const { rows, hasMore } = await tenantRepo.listTenants(orgId, db, query);
  const items = rows.map(mapTenant);
  const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1]!.id) : null;
  return c.json({ items, nextCursor });
});

tenants.post('/v1/tenants', validateBody(createTenantBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const body = parsedBody<CreateTenantBody>(c);

  const created = await tenantRepo.createTenant(orgId, db, body);
  return c.json(mapTenant(created), 201);
});

tenants.get('/v1/tenants/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Tenant');

  const row = await tenantRepo.getTenant(orgId, db, id);
  if (!row) throw notFound('Tenant');
  return c.json(mapTenant(row));
});

tenants.patch('/v1/tenants/:id', validateBody(updateTenantBody), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Tenant');
  const body = parsedBody<UpdateTenantBody>(c);

  const updated = await tenantRepo.updateTenant(orgId, db, id, body);
  if (!updated) throw notFound('Tenant');
  return c.json(mapTenant(updated));
});

tenants.delete('/v1/tenants/:id', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Tenant');

  // docs/PLAN-PHASE2.md §3.6: 409 while the tenant is on any active lease, rather
  // than archiving them out from under a tenancy that is still being billed.
  const activeLeaseCount = await leaseRepo.countActiveLeasesForTenant(orgId, db, id);
  if (activeLeaseCount > 0) {
    throw conflict('This tenant is on an active lease. End the lease before removing the tenant.');
  }

  const ok = await tenantRepo.archiveTenant(orgId, db, id);
  if (!ok) throw notFound('Tenant');
  return c.body(null, 204);
});

tenants.post('/v1/tenants/:id/invite', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Tenant');

  const tenantRow = await tenantRepo.getTenant(orgId, db, id);
  if (!tenantRow) throw notFound('Tenant');

  // Explicit 400, not a crash — the task brief's requirement, stricter than a bare
  // "422 missing field" would be since there is no request body here to validate.
  if (!tenantRow.email) {
    throw badRequest('This tenant has no email on file. Add one before sending an invite.');
  }
  if (tenantRow.userId) {
    throw conflict('This tenant already has portal access.');
  }

  const token = generateInviteToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // "Resend" IS "invite again": createInvite revokes any live invite first.
  await tenantRepo.createInvite(orgId, db, id, {
    email: tenantRow.email,
    tokenHash,
    expiresAt,
    createdByUserId: userId,
  });

  const url = new URL('/portal/accept', c.env.WEB_ORIGIN);
  url.searchParams.set('token', token);

  const orgName = await getOrganizationName(db, orgId);
  const email = renderInviteEmail({
    orgName: orgName ?? 'Your landlord',
    tenantFirstName: tenantRow.firstName,
    url: url.toString(),
  });
  await sendEmail(c.env, { ...email, to: tenantRow.email });

  const response: InviteCreated = {
    url: url.toString(),
    email: tenantRow.email,
    expiresAt: expiresAt.toISOString(),
  };
  return c.json(response, 201);
});

tenants.delete('/v1/tenants/:id/portal-access', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const id = requireUuidParam(c.req.param('id'), 'Tenant');

  const ok = await tenantRepo.revokePortalAccess(orgId, db, id);
  if (!ok) throw notFound('Tenant');
  return c.body(null, 204);
});
