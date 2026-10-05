import { createMiddleware } from 'hono/factory';
import { requireAuth, requireSession, requireTenant } from './auth.js';
import type { AppBindings } from '../types.js';

/**
 * Which actor each `/v1` path requires. One table, one place, read top to bottom.
 *
 * This is deliberately NOT expressed as `router.use('*', …)` inside each router. A
 * router that does that and is then mounted with `app.route('/', router)` registers
 * its middleware at `/*`, matching EVERY path in the application rather than only its
 * own. That is exactly how `requireAuth` ended up in front of the public
 * invite-accept route and the whole tenant portal: `properties` mounted first, its
 * wildcard swallowed everything, and tenants — who by design have no organization —
 * were rejected before any portal handler ran.
 *
 * No router-level test could catch it, because each router was tested on its own app
 * instance where the wildcard covered only that router. It was visible the instant
 * the assembled app served one request. Tests must therefore exercise THIS middleware,
 * not a per-router stand-in.
 *
 * The fallthrough is the most restrictive actor, not the least. A new route added
 * under /v1 without touching this table requires a landlord session: forgetting to
 * classify a route makes it unreachable, never public.
 */
const PUBLIC_PATHS = new Set([
  // Accepting an invite is how a tenant gets an account at all, so it cannot require
  // one. Its safety comes from the 256-bit token, not from a session.
  '/v1/portal/invites/accept',
]);

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export const authLayer = createMiddleware<AppBindings>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.has(path)) return next();
  if (under(path, '/v1/portal')) return requireTenant(c, next);
  if (under(path, '/v1/me')) return requireSession(c, next);
  return requireAuth(c, next);
});
