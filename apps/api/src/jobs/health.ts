import type { Database } from '../db/index.js';
import * as jobRunRepo from '../db/repo/system/job-run.js';

/**
 * The health endpoint's data (PLAN-PHASE3A.md §5.2), kept under `jobs/` rather
 * than read directly from `routes/internal.ts` — `repo/system/**` may only ever
 * be imported from `src/jobs/**` (`system-repo.guard.test.ts`'s import-graph
 * check), with no carve-out for "it's only a read". Keeping that rule absolute,
 * rather than adding an exception for this one route, is what keeps it worth
 * having at all.
 *
 * TWO queries, not one (review finding BLOCKING-2 — the plan's own "the health
 * endpoint's only query, LIMIT 1" note is wrong, and the JSON example it gives is
 * the part that actually matters): `lastRunStatus` comes from the LATEST run of
 * any status; `lastSuccessAt`/`ageSeconds` come from the latest run that actually
 * SUCCEEDED. Collapsing these into one query (the latest row, whatever its
 * status) would report a failing-every-day cron as having a fresh
 * `lastSuccessAt` — a `failed` or stuck `running` row's own timestamp is not a
 * success just because it is the most recent row.
 */
export interface CronHealth {
  ok: boolean;
  lastSuccessAt: string | null;
  lastRunStatus: 'running' | 'ok' | 'failed' | null;
  ageSeconds: number | null;
}

export async function getCronHealth(db: Database, job = 'daily'): Promise<CronHealth> {
  const [latest, latestOk] = await Promise.all([
    jobRunRepo.latestRun(db, job),
    jobRunRepo.latestOkRun(db, job),
  ]);

  if (!latestOk) {
    return { ok: latest?.status === 'ok', lastSuccessAt: null, lastRunStatus: latest?.status ?? null, ageSeconds: null };
  }

  // `finishedAt` is null only while a run is still in flight — never true for a
  // row with `status: 'ok'`, since `finishRun` sets both together. Kept as a
  // fallback anyway so a future caller narrowing this query differently cannot
  // silently produce a null `ageSeconds` for a genuinely successful run.
  const reference = latestOk.finishedAt ?? latestOk.startedAt;
  const ageSeconds = Math.floor((Date.now() - reference.getTime()) / 1000);

  return {
    ok: latest?.status === 'ok',
    lastSuccessAt: reference.toISOString(),
    lastRunStatus: latest?.status ?? null,
    ageSeconds,
  };
}
