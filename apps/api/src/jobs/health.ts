import type { Database } from '../db/index.js';
import * as jobRunRepo from '../db/repo/system/job-run.js';

/**
 * The health endpoint's data (PLAN-PHASE3A.md §5.2), kept under `jobs/` rather
 * than read directly from `routes/internal.ts` — `repo/system/**` may only ever
 * be imported from `src/jobs/**` (`system-repo.guard.test.ts`'s import-graph
 * check), with no carve-out for "it's only a read". Keeping that rule absolute,
 * rather than adding an exception for this one route, is what keeps it worth
 * having at all.
 */
export interface CronHealth {
  ok: boolean;
  lastSuccessAt: string | null;
  lastRunStatus: 'running' | 'ok' | 'failed' | null;
  ageSeconds: number | null;
}

export async function getCronHealth(db: Database, job = 'daily'): Promise<CronHealth> {
  const run = await jobRunRepo.latestRun(db, job);
  if (!run) {
    return { ok: false, lastSuccessAt: null, lastRunStatus: null, ageSeconds: null };
  }

  // `finishedAt` is null while a run is still in flight, or if the Worker died
  // mid-run (schema.ts's own comment on the column) — fall back to `startedAt` so
  // `ageSeconds` always has a reference point, which is exactly the signal a stuck
  // `running` row is supposed to surface.
  const reference = run.finishedAt ?? run.startedAt;
  const ageSeconds = Math.floor((Date.now() - reference.getTime()) / 1000);

  return {
    ok: run.status === 'ok',
    lastSuccessAt: reference.toISOString(),
    lastRunStatus: run.status,
    ageSeconds,
  };
}
