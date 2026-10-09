import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@rms/contract';
import type { Database } from '../../index.js';
import { jobRun } from '../../schema.js';

/**
 * `job_run` is the one table in this schema with no `org_id` — it describes the
 * SYSTEM (one cron run across every org), not a tenant (schema.ts's own comment on
 * the table). This is the one explicitly named exception to `repo/system/`'s
 * "every insert selects orgId" rule in `system-repo.guard.test.ts`.
 *
 * `job_run` is a heartbeat, never a lock: nothing here serialises concurrent runs,
 * because the generator's own idempotency comes from `charge_generation_uq`, not
 * from this table (PLAN-PHASE3A.md §4.1).
 */

export interface JobRunStats {
  leasesScanned: number;
  chargesWritten: number;
  leasesFailed: number;
  errors: { leaseId: string; orgId: string; message: string }[];
}

export type JobRunStatus = 'running' | 'ok' | 'failed';

export interface JobRunRow {
  id: string;
  job: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: JobRunStatus;
  stats: JobRunStats;
  error: string | null;
}

export async function startRun(db: Database, job: string): Promise<string> {
  const id = uuidv7();
  await db.insert(jobRun).values({
    id,
    job,
    startedAt: new Date(),
    status: 'running',
    stats: { leasesScanned: 0, chargesWritten: 0, leasesFailed: 0, errors: [] },
  });
  return id;
}

export async function finishRun(
  db: Database,
  id: string,
  status: 'ok' | 'failed',
  stats: JobRunStats,
  error?: string,
): Promise<void> {
  await db
    .update(jobRun)
    .set({ finishedAt: new Date(), status, stats, error: error ?? null })
    .where(eq(jobRun.id, id));
}

/**
 * The latest run of ANY status — drives the health endpoint's `lastRunStatus`.
 * `ORDER BY started_at DESC LIMIT 1`.
 */
export async function latestRun(db: Database, job: string): Promise<JobRunRow | null> {
  const [row] = await db
    .select()
    .from(jobRun)
    .where(eq(jobRun.job, job))
    .orderBy(desc(jobRun.startedAt))
    .limit(1);
  return (row as JobRunRow | undefined) ?? null;
}

/**
 * The latest run that actually SUCCEEDED — drives the health endpoint's
 * `lastSuccessAt`/`ageSeconds`. Deliberately a SEPARATE query from `latestRun`
 * (review finding BLOCKING-2): `latestRun` alone cannot answer "when did we last
 * succeed", because the MOST RECENT row might be `failed` or a `running` row that
 * never finished — reporting either one's own `startedAt`/`finishedAt` as a
 * "success" timestamp would keep `ageSeconds` looking fresh while the cron fails
 * every single day, which is exactly the signal the external watcher
 * (PLAN-PHASE3A.md §5.2) needs to catch.
 */
export async function latestOkRun(db: Database, job: string): Promise<JobRunRow | null> {
  const [row] = await db
    .select()
    .from(jobRun)
    .where(and(eq(jobRun.job, job), eq(jobRun.status, 'ok')))
    .orderBy(desc(jobRun.startedAt))
    .limit(1);
  return (row as JobRunRow | undefined) ?? null;
}
