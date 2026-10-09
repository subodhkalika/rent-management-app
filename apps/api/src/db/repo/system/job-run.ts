import { desc, eq } from 'drizzle-orm';
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

/** The health endpoint's ONLY query — `ORDER BY started_at DESC LIMIT 1`. */
export async function latestRun(db: Database, job: string): Promise<JobRunRow | null> {
  const [row] = await db
    .select()
    .from(jobRun)
    .where(eq(jobRun.job, job))
    .orderBy(desc(jobRun.startedAt))
    .limit(1);
  return (row as JobRunRow | undefined) ?? null;
}
