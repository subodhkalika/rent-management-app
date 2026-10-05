import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { asc, eq } from 'drizzle-orm';
import { createDb, schema } from '../db/index.js';
import { sendEmail, renderResetPasswordEmail } from './email.js';
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
    database: drizzleAdapter(createDb(env.DATABASE_URL, env.NEON_LOCAL_FETCH_ENDPOINT), {
      provider: 'pg',
      schema,
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      // Landlords had no password-recovery path at all before this phase — see
      // docs/PLAN-V1.md §1.3. Tenants get the same flow; Better Auth doesn't
      // distinguish the two actor types, which is fine here since a password reset
      // only ever needs the already-verified email on the user row.
      sendResetPassword: async ({ user, url }) => {
        const email = renderResetPasswordEmail({ userName: user.name, url });
        await sendEmail(env, { ...email, to: user.email });
      },
    },
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
    databaseHooks: {
      session: {
        create: {
          // The organization plugin does NOT set `activeOrganizationId` on its own —
          // without this, `requireAuth` 403s "Select an organization before
          // continuing" on every request, forever, since nothing in this app's UI
          // flow calls `setActive` either. Default new sessions to the user's
          // earliest membership; a user who later joins/switches orgs changes this
          // explicitly via the organization plugin's `setActive` endpoint.
          before: async (session) => {
            const db = createDb(env.DATABASE_URL, env.NEON_LOCAL_FETCH_ENDPOINT);
            const [membership] = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, session.userId))
              .orderBy(asc(schema.member.createdAt))
              .limit(1);

            if (!membership) return;
            return { data: { activeOrganizationId: membership.organizationId } };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth['$Infer']['Session'];

export async function getSession(req: Request, env: Env): Promise<Session | null> {
  return createAuth(env).api.getSession({ headers: req.headers });
}
