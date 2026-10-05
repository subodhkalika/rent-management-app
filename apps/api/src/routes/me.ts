import { Hono } from 'hono';
import type { MeContext } from '@rms/contract';
import { requireSession } from '../middleware/auth.js';
import { getSession } from '../lib/auth.js';
import { getLandlordMembership } from '../db/repo/auth/organization.js';
import { resolveScope } from '../db/repo/portal/scope.js';
import { unauthorized } from '../lib/errors.js';
import type { AppBindings } from '../types.js';

export const me = new Hono<AppBindings>();

me.use('*', requireSession);

/**
 * "Who am I, and in what capacity" — docs/PLAN-V1.md §3.1. The web root guard uses
 * this (not `session.activeOrganizationId`) to decide between the landlord app and
 * the tenant portal, because a tenant can create their own (empty) organization and
 * having one is therefore not proof of being a landlord — see
 * docs/PLAN-V1.md §7.1.
 */
me.get('/v1/me/context', async (c) => {
  const db = c.get('db');
  const session = await getSession(c.req.raw, c.env);
  if (!session?.user) throw unauthorized();

  const activeOrgId = session.session.activeOrganizationId;
  const landlord = activeOrgId ? await getLandlordMembership(db, session.user.id, activeOrgId) : null;

  const tenancyRows = await resolveScope(session.user.id, db);

  const context: MeContext = {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    landlord,
    tenancies: tenancyRows.map((r) => ({ orgId: r.orgId, orgName: r.orgName, tenantId: r.tenantId })),
  };

  return c.json(context);
});
