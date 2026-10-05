import type { Database } from './db/index.js';

/**
 * A tenant's entire authorization surface, resolved fresh on every request by
 * `requireTenant` (middleware/auth.ts) from `resolveScope` (db/repo/portal/scope.ts).
 *
 * `pairs` is never empty by the time this is set on the context — `requireTenant`
 * 403s before setting it if a user has zero live tenant rows. A tenant route that
 * touches a child resource resolves the parent through a `repo/portal/*` function
 * taking this first, gets back a trusted `(orgId, tenantId)` pair, and only then calls
 * an ordinary `(orgId, db, ...)` landlord repo function — "verify-then-scope",
 * docs/PLAN-V1.md §1.4.
 */
export interface TenantScope {
  userId: string;
  pairs: ReadonlyArray<{ orgId: string; tenantId: string }>;
}

export interface Env {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  /** Mailtrap sandbox, local development only — see lib/email.ts. */
  MAILTRAP_API_TOKEN?: string;
  MAILTRAP_INBOX_ID?: string;
  /** Optional. Falls back to Resend's sandbox sender (lib/email.ts) — fine until a
   *  verified domain exists (blocking prerequisite for Phase 4, docs/PLAN-V1.md §6). */
  RESEND_FROM_EMAIL?: string;
  WEB_ORIGIN: string;
  /**
   * Dev-only. Set by the Docker Compose stack so the HTTP driver talks to the local
   * Neon HTTP proxy sidecar instead of real Neon. Absent on every deployed Worker —
   * see `createDb` in `db/index.ts` for why the override is needed at all.
   */
  NEON_LOCAL_FETCH_ENDPOINT?: string;
}

/**
 * Hono context shape.
 *
 * `orgId` and `userId` are set by auth middleware from the verified session and are
 * the ONLY trusted source of tenancy. Route handlers must never read an org id from
 * the request body, query string, or path — a client controls all three.
 */
export interface AppBindings {
  Bindings: Env;
  Variables: {
    db: Database;
    userId: string;
    /** Set by `requireAuth` ONLY. Never set on a portal (tenant) request. */
    orgId: string;
    /** Set by `requireTenant` ONLY. Never set on a landlord request. */
    tenantScope: TenantScope;
    /** Parsed by `validateBody`/`validateQuery`. Retrieve with `parsedBody`/
     *  `parsedQuery` from `middleware/validate.ts` rather than `c.get` directly —
     *  those give back the schema's inferred type instead of `unknown`. */
    body: unknown;
    query: unknown;
  };
}
