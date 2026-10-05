import { createMiddleware } from 'hono/factory';
import { eq, and } from 'drizzle-orm';
import { member } from '../db/schema.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { getSession } from '../lib/auth.js';
import { resolveScope } from '../db/repo/portal/scope.js';
import type { AppBindings } from '../types.js';

/**
 * Resolves the caller's identity and active organization, then pins both onto the
 * context. Everything downstream trusts `c.get('orgId')` and nothing else.
 *
 * The active org is read from the verified session, then re-checked against the
 * `member` table on every request. A stale session must not keep access after the
 * user is removed from an organization.
 *
 * Note for the attack table (docs/PLAN-V1.md §1.6): a tenant never has an active
 * organization, because tenants are never given a `member` row (the load-bearing
 * decision — see docs/PLAN-V1.md §1.1). So this throws on the `!activeOrgId` check,
 * BEFORE the `member` query below ever runs — a tenant hitting any landlord route
 * is rejected before a single query touches the database.
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

/**
 * The common prerequisite for both actor types: a verified session, nothing more.
 * Used by `GET /v1/me/context`, which has to answer "landlord, tenant, both, or
 * neither" BEFORE either `requireAuth` or `requireTenant` could apply.
 */
export const requireSession = createMiddleware<AppBindings>(async (c, next) => {
  const session = await getSession(c.req.raw, c.env);
  if (!session?.user) throw unauthorized();

  c.set('userId', session.user.id);
  await next();
});

/**
 * Resolves a tenant's entire authorization scope — every live `(orgId, tenantId)`
 * pair across every org they rent from — fresh, from the database, on every single
 * request. Never cached, never derived from the session's `activeOrganizationId`
 * (tenants never have one — see `requireAuth`'s note above).
 *
 * This is what makes "archive a tenant mid-session" take effect immediately: there
 * is no session state to invalidate, because nothing about tenancy was ever stored
 * in the session in the first place. The next request just resolves an empty (or
 * smaller) scope and 403s, the same way `requireAuth` re-checks `member` today.
 */
export const requireTenant = createMiddleware<AppBindings>(async (c, next) => {
  const session = await getSession(c.req.raw, c.env);
  if (!session?.user) throw unauthorized();

  const rows = await resolveScope(session.user.id, c.get('db'));
  if (rows.length === 0) {
    throw forbidden('You do not have tenant portal access');
  }

  c.set('userId', session.user.id);
  c.set('tenantScope', {
    userId: session.user.id,
    pairs: rows.map((r) => ({ orgId: r.orgId, tenantId: r.tenantId })),
  });
  await next();
});
