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
  // An exact string, never a prefix (PLAN-PHASE3A.md §5.2) — a prefix entry here
  // would be exactly the loosening this file's fallthrough-to-most-restrictive rule
  // exists to prevent. Safe to leave public: it returns a timestamp and a status,
  // nothing cross-org (see routes/internal.ts's own comment).
  '/v1/internal/cron/health',
]);

/**
 * Public paths that carry a variable segment, so a `Set` of exact strings cannot
 * express them. Kept separate from `PUBLIC_PATHS` and matched by REGEXP, not by
 * prefix — a prefix match here (`under(path, '/v1/portal/invites')`) would also
 * expose any future route nested under `/invites/`, which is exactly the kind of
 * loosening this file's fallthrough is designed to prevent. Each pattern must be
 * anchored (`^...$`) and as narrow as the real route it stands for.
 *
 * `GET /v1/portal/invites/:token` (the invite preview, docs/TASKS/
 * 005-phase1-amendments.md §1) is the one case so far: the token IS the credential
 * — a 256-bit value only the emailed link holder has — so this is exactly as safe
 * as the exact-string entry above, just shaped differently because the token lives
 * in the path instead of being a fixed suffix.
 *
 * The pattern matches exactly ONE path segment after `/invites/` — not the token's
 * own hex shape. That is deliberate, not loose: the route handler (routes/portal.ts)
 * validates the token against the contract's `inviteToken` schema itself and folds
 * a malformed one into the SAME `inviteInvalid()` 404 as every other invalid state
 * (expired, revoked, accepted, archived, …). If this regex required valid hex
 * instead, a malformed token would fail here — before the handler runs — and come
 * back as a 401/403 from `requireTenant` instead, a different status for a case
 * that must look identical to every other kind of invalid invite. One un-nested
 * segment is exactly as narrow as the route it stands for: it cannot match
 * `/v1/portal/:tenantId/profile` (always ends in `/profile`), and it cannot match
 * anything with a further path segment after it.
 */
const PUBLIC_PATH_PATTERNS: RegExp[] = [/^\/v1\/portal\/invites\/[^/]+$/];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

export const authLayer = createMiddleware<AppBindings>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.has(path)) return next();
  if (PUBLIC_PATH_PATTERNS.some((pattern) => pattern.test(path))) return next();
  if (under(path, '/v1/portal')) return requireTenant(c, next);
  if (under(path, '/v1/me')) return requireSession(c, next);
  return requireAuth(c, next);
});
