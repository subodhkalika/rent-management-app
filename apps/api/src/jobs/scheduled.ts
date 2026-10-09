import { createDb } from '../db/index.js';
import { runDailyJob } from './daily.js';
import type { Env } from '../types.js';

/**
 * The Cloudflare Cron Trigger entry point (`triggers.crons` in wrangler.jsonc).
 * Does nothing but build a `Database` from `env` and call `runDailyJob` — the run
 * instant is captured HERE, once, and passed down, so every lease this run touches
 * sees the identical clock (PLAN-PHASE3A.md §5.1).
 */
export async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DATABASE_URL, env.NEON_LOCAL_FETCH_ENDPOINT);
  ctx.waitUntil(runDailyJob(db, new Date()));
}
