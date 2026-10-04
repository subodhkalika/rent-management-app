import { createMiddleware } from 'hono/factory';
import { eq, and } from 'drizzle-orm';
import { member } from '../db/schema.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { getSession } from '../lib/auth.js';
import type { AppBindings } from '../types.js';

/**
 * Resolves the caller's identity and active organization, then pins both onto the
 * context. Everything downstream trusts `c.get('orgId')` and nothing else.
 *
 * The active org is read from the verified session, then re-checked against the
 * `member` table on every request. A stale session must not keep access after the
 * user is removed from an organization.
 */
export const requireAuth = createMiddleware<AppBindings>(async (c, next) => {
  const session = await getSession(c.req.raw, c.env);
  if (!session?.user) throw unauthorized();

  const activeOrgId = session.session.activeOrganizationId;
  if (!activeOrgId) {
    throw forbidden('Select an organization before continuing');
  }

  const membership = await c.get('db').query.member.findFirst({
    where: and(eq(member.organizationId, activeOrgId), eq(member.userId, session.user.id)),
  });
  if (!membership) throw forbidden('You are not a member of this organization');

  c.set('userId', session.user.id);
  c.set('orgId', activeOrgId);
  await next();
});

/** Restricts a route to organization owners/admins (e.g. billing, member management). */
export const requireAdmin = createMiddleware<AppBindings>(async (c, next) => {
  const membership = await c.get('db').query.member.findFirst({
    where: and(
      eq(member.organizationId, c.get('orgId')),
      eq(member.userId, c.get('userId')),
    ),
  });
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    throw forbidden('This action requires an admin role');
  }
  await next();
});
