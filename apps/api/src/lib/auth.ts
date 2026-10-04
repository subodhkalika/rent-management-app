import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { createDb, schema } from '../db/index.js';
import type { Env } from '../types.js';

/**
 * Better Auth owns sessions, password hashing and the organization model.
 *
 * Built per request rather than once at module scope: Workers forbid I/O at module
 * init, and `env` is only available inside a request anyway.
 */
export function createAuth(env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(createDb(env.DATABASE_URL), {
      provider: 'pg',
      schema,
    }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    trustedOrigins: [env.WEB_ORIGIN],
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24,      // refresh at most daily
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    plugins: [
      organization({
        // A landlord signing up gets their own organization. Every domain row hangs
        // off this id — it is the tenant boundary.
        allowUserToCreateOrganization: true,
        organizationLimit: 5,
        creatorRole: 'owner',
        membershipLimit: 20,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth['$Infer']['Session'];

export async function getSession(req: Request, env: Env): Promise<Session | null> {
  return createAuth(env).api.getSession({ headers: req.headers });
}
