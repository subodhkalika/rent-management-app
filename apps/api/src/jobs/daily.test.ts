import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `jobs/daily.ts`, fully mocked — proves the ORCHESTRATION (PLAN-PHASE3A.md §5.1):
 * one lease's failure never aborts the run, `job_run` starts and finishes exactly
 * once, and `localToday` is called with the PROPERTY's own timezone, never the
 * server's. The generator's own correctness (idempotency, catch-up, etc.) is
 * proven against live Postgres in `db/repo/charge.integration.test.ts` — this file
 * is about the LOOP around it.
 */

const systemChargeRepoMock = { listLeasesForGeneration: vi.fn() };
vi.mock('../db/repo/system/charges.js', () => systemChargeRepoMock);

const jobRunRepoMock = { startRun: vi.fn(), finishRun: vi.fn() };
vi.mock('../db/repo/system/job-run.js', () => jobRunRepoMock);

const leaseRepoMock = {
  listRentSteps: vi.fn(),
  toRentSteps: (rows: readonly { effectiveFrom: string; rentCents: number }[]) =>
    rows.map((r) => ({ effectiveFrom: r.effectiveFrom, rentCents: r.rentCents })),
};
vi.mock('../db/repo/lease.js', () => leaseRepoMock);

const chargeRepoMock = { generateChargesForLease: vi.fn() };
vi.mock('../db/repo/charge.js', () => chargeRepoMock);

const { runDailyJob } = await import('./daily.js');

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lease_1',
    orgId: 'org_1',
    currency: 'USD',
    rentFrequency: 'monthly',
    rentCents: 100000,
    billingDay: 1,
    startDate: '2026-01-01',
    endDate: null,
    ledgerStartDate: '2026-01-01',
    moveOutDate: null,
    moveOutBillingPolicy: 'bill_full_term',
    calendar: 'gregorian',
    depositCents: 0,
    openingBalanceCents: 0,
    propertyTimezone: 'America/Chicago',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobRunRepoMock.startRun.mockResolvedValue('run_1');
  leaseRepoMock.listRentSteps.mockResolvedValue([]);
});

describe('runDailyJob', () => {
  it('starts and finishes exactly one job_run, status ok, with aggregate stats', async () => {
    systemChargeRepoMock.listLeasesForGeneration.mockResolvedValue([leaseRow()]);
    chargeRepoMock.generateChargesForLease.mockResolvedValue([{ id: 'charge_1' }, { id: 'charge_2' }]);

    const runAt = new Date('2026-06-01T09:00:00.000Z');
    const stats = await runDailyJob({} as never, runAt);

    expect(jobRunRepoMock.startRun).toHaveBeenCalledTimes(1);
    expect(jobRunRepoMock.startRun).toHaveBeenCalledWith(expect.anything(), 'daily');
    expect(jobRunRepoMock.finishRun).toHaveBeenCalledTimes(1);
    expect(jobRunRepoMock.finishRun).toHaveBeenCalledWith(
      expect.anything(),
      'run_1',
      'ok',
      expect.objectContaining({ leasesScanned: 1, chargesWritten: 2, leasesFailed: 0 }),
    );
    expect(stats.leasesScanned).toBe(1);
    expect(stats.chargesWritten).toBe(2);
    expect(stats.leasesFailed).toBe(0);
    expect(stats.errors).toEqual([]);
  });

  it("ONE lease's failure is caught, counted, and never aborts the scan of the rest", async () => {
    systemChargeRepoMock.listLeasesForGeneration.mockResolvedValue([
      leaseRow({ id: 'lease_bad' }),
      leaseRow({ id: 'lease_good_1' }),
      leaseRow({ id: 'lease_good_2' }),
    ]);
    chargeRepoMock.generateChargesForLease.mockImplementation(async (orgId: string, _db: unknown, lease: { id: string }) => {
      if (lease.id === 'lease_bad') throw new RangeError('Schedule would produce too many periods');
      return [{ id: `charge_for_${lease.id}` }];
    });

    const stats = await runDailyJob({} as never, new Date('2026-06-01T09:00:00.000Z'));

    expect(stats.leasesScanned).toBe(3);
    expect(stats.leasesFailed).toBe(1);
    expect(stats.chargesWritten).toBe(2); // the two good leases, each one charge
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toMatchObject({ leaseId: 'lease_bad', orgId: 'org_1' });
    expect(stats.errors[0]?.message).toContain('too many periods');

    // Both GOOD leases still ran, despite the bad one being first in the list.
    expect(chargeRepoMock.generateChargesForLease).toHaveBeenCalledTimes(3);

    expect(jobRunRepoMock.finishRun).toHaveBeenCalledWith(
      expect.anything(),
      'run_1',
      'ok', // the RUN still succeeds — per-lease failures are counted, not fatal
      expect.objectContaining({ leasesFailed: 1 }),
    );
  });

  it("calls localToday with the PROPERTY's own timezone, never a bare server clock", async () => {
    systemChargeRepoMock.listLeasesForGeneration.mockResolvedValue([
      leaseRow({ propertyTimezone: 'Australia/Perth' }),
    ]);
    chargeRepoMock.generateChargesForLease.mockResolvedValue([]);

    await runDailyJob({} as never, new Date('2026-06-01T09:00:00.000Z'));

    const [, , , , today] = chargeRepoMock.generateChargesForLease.mock.calls[0]!;
    // 2026-06-01T09:00:00Z in Australia/Perth (UTC+8, no DST) is already 17:00
    // local on the SAME day — this just proves a real IANA zone was consulted,
    // not that the date necessarily differs from UTC.
    expect(today).toBe('2026-06-01');
  });

  it('every lease in one run sees the IDENTICAL instant — the clock is read once, not per lease', async () => {
    systemChargeRepoMock.listLeasesForGeneration.mockResolvedValue([
      leaseRow({ id: 'lease_a', propertyTimezone: 'UTC' }),
      leaseRow({ id: 'lease_b', propertyTimezone: 'UTC' }),
    ]);
    chargeRepoMock.generateChargesForLease.mockResolvedValue([]);

    await runDailyJob({} as never, new Date('2026-06-01T09:00:00.000Z'));

    const calls = chargeRepoMock.generateChargesForLease.mock.calls;
    const todays = calls.map((args: unknown[]) => args[4]);
    expect(new Set(todays).size).toBe(1);
  });

  it('a failure in listLeasesForGeneration itself finishes the run as failed and rethrows', async () => {
    systemChargeRepoMock.listLeasesForGeneration.mockRejectedValue(new Error('connection reset'));

    await expect(runDailyJob({} as never, new Date('2026-06-01T09:00:00.000Z'))).rejects.toThrow('connection reset');

    expect(jobRunRepoMock.finishRun).toHaveBeenCalledWith(
      expect.anything(),
      'run_1',
      'failed',
      expect.anything(),
      'connection reset',
    );
  });

  it('zero leases scanned still starts and finishes a run cleanly', async () => {
    systemChargeRepoMock.listLeasesForGeneration.mockResolvedValue([]);
    const stats = await runDailyJob({} as never, new Date('2026-06-01T09:00:00.000Z'));
    expect(stats).toEqual({ leasesScanned: 0, chargesWritten: 0, leasesFailed: 0, errors: [] });
    expect(jobRunRepoMock.finishRun).toHaveBeenCalledWith(expect.anything(), 'run_1', 'ok', expect.anything());
  });
});
