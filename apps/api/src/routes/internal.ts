import { Hono } from 'hono';
import { getCronHealth } from '../jobs/health.js';
import type { AppBindings } from '../types.js';

/**
 * `GET /v1/internal/cron/health` — PUBLIC (middleware/auth-layer.ts's `PUBLIC_PATHS`,
 * as an EXACT string, never a prefix). Backed by `jobs/health.ts`, not a direct
 * read of `repo/system/job-run.ts` here — `repo/system/**` may only ever be
 * imported from `src/jobs/**` (`system-repo.guard.test.ts`), with no exception for
 * "it's only a read".
 *
 * Public, with no counts, deliberately (PLAN-PHASE3A.md §5.2): the alternative, a
 * shared-secret header, buys nothing here. The response carries a timestamp and a
 * status, nothing cross-org — shipping a secret would be an authenticated hole in
 * the API that exists only because the watcher (a weekly GitHub Actions poll) is
 * external.
 */
export const internal = new Hono<AppBindings>();

internal.get('/v1/internal/cron/health', async (c) => {
  const db = c.get('db');
  const health = await getCronHealth(db);
  return c.json(health);
});
