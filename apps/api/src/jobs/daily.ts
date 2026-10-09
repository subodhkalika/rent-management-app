import { localToday } from '@rms/contract';
import type { Database } from '../db/index.js';
import * as systemChargeRepo from '../db/repo/system/charges.js';
import * as jobRunRepo from '../db/repo/system/job-run.js';
import * as chargeRepo from '../db/repo/charge.js';
import type { JobRunStats } from '../db/repo/system/job-run.js';

/**
 * The scheduled job's body (PLAN-PHASE3A.md §5.1). Called by `jobs/scheduled.ts`
 * (the Cloudflare Cron Trigger entry point) and directly by tests — never reads a
 * clock itself, `runAt` is captured once by the caller and threaded down so every
 * lease in one run sees the identical instant.
 *
 * ONE lease's failure must never abort the run: a Bikram Sambat lease running past
 * the data table throws `BsDateOutOfRangeError`, a `MAX_SCHEDULE_PERIODS` breach
 * throws `RangeError`. Both are caught PER LEASE, counted into `stats.errors`, and
 * the rest of the scan continues — an uncaught throw at lease 3 of 400 would be an
 * outage nobody notices until a tenant complains.
 *
 * Exactly ONE statement per lease — the INSERT inside `generateChargesForLease`.
 * `systemChargeRepo.listLeasesForGeneration` folds the rent ladder into its own
 * SELECT (see that module's comment); this file must never add a second per-lease
 * query (e.g. a `leaseRepo.listRentSteps` call) back in — on the Workers free
 * plan's subrequest ceiling that silently halves how many leases one run can
 * reach, and the ones past the limit are caught by the try/catch below and
 * counted as a failure forever, every day.
 */
export async function runDailyJob(db: Database, runAt: Date): Promise<JobRunStats> {
  const runId = await jobRunRepo.startRun(db, 'daily');
  const stats: JobRunStats = { leasesScanned: 0, chargesWritten: 0, leasesFailed: 0, errors: [] };

  try {
    const leases = await systemChargeRepo.listLeasesForGeneration(db);

    for (const row of leases) {
      stats.leasesScanned += 1;
      try {
        // The ONLY clock read — the PROPERTY's zone, never the server's, never a
        // tenant's.
        const today = localToday(row.propertyTimezone, runAt);
        const created = await chargeRepo.generateChargesForLease(row.orgId, db, row, row.rentSteps, today);
        stats.chargesWritten += created.length;
      } catch (err) {
        stats.leasesFailed += 1;
        stats.errors.push({
          leaseId: row.id,
          orgId: row.orgId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // A run with ANY per-lease failure is NOT 'ok' — the health endpoint's
    // `lastSuccessAt` (jobs/health.ts) reads the latest run with status 'ok', so
    // hardcoding 'ok' here would report healthy on a day that silently failed to
    // bill part of the portfolio.
    const status = stats.leasesFailed > 0 ? 'failed' : 'ok';
    await jobRunRepo.finishRun(db, runId, status, stats);
  } catch (err) {
    await jobRunRepo.finishRun(db, runId, 'failed', stats, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return stats;
}
