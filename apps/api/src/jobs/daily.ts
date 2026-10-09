import { localToday } from '@rms/contract';
import type { Database } from '../db/index.js';
import * as systemChargeRepo from '../db/repo/system/charges.js';
import * as jobRunRepo from '../db/repo/system/job-run.js';
import * as leaseRepo from '../db/repo/lease.js';
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
        const rentStepRows = await leaseRepo.listRentSteps(row.orgId, db, row.id);
        const rentSteps = leaseRepo.toRentSteps(rentStepRows);
        const created = await chargeRepo.generateChargesForLease(row.orgId, db, row, rentSteps, today);
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

    await jobRunRepo.finishRun(db, runId, 'ok', stats);
  } catch (err) {
    await jobRunRepo.finishRun(db, runId, 'failed', stats, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return stats;
}
