import { eq } from 'drizzle-orm';
import type { Database } from '../../index.js';
import { user } from '../../schema.js';

/**
 * Direct access to Better Auth's OWN `user` table — not org-owned, so the ordinary
 * `orgId`-first convention (db/repo/*.ts) does not apply, the same precedent
 * `requireAuth`/`requireAdmin` already set by querying `member` directly in
 * middleware/auth.ts.
 *
 * Pulled into its own guarded directory rather than left as an inline query in a
 * route handler: `auth-tables.guard.test.ts` statically asserts every file here only
 * ever imports Better Auth's own tables from schema.ts, never a domain table. A
 * query written directly in `routes/` is invisible to every guard in this repo by
 * construction — this directory exists so that stops being true for this one
 * legitimate exception too.
 */
export async function markEmailVerified(db: Database, userId: string): Promise<void> {
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
}
