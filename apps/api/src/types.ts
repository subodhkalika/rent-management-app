import type { Database } from './db/index.js';

export interface Env {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  RESEND_API_KEY?: string;
  WEB_ORIGIN: string;
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
    orgId: string;
    /** Parsed by `validateBody`/`validateQuery`. Retrieve with `parsedBody`/
     *  `parsedQuery` from `middleware/validate.ts` rather than `c.get` directly —
     *  those give back the schema's inferred type instead of `unknown`. */
    body: unknown;
    query: unknown;
  };
}
