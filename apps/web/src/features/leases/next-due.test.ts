import { describe, expect, it } from 'vitest';
import type { PlannedCharge } from '@rms/contract';
import { nextDuePeriodIndex } from './next-due';

function charge(dueDate: string): PlannedCharge {
  return {
    generationKey: dueDate,
    periodIndex: 0,
    periodStart: dueDate,
    periodEnd: dueDate,
    occupiedStart: dueDate,
    occupiedEnd: dueDate,
    daysOccupied: 1,
    daysInPeriod: 1,
    dueDate,
    amountCents: 100000,
    isProrated: false,
  };
}

describe('nextDuePeriodIndex', () => {
  // This is the test the task calls out explicitly: a lease 12+ hours from the
  // runner's own timezone must still be judged by the PROPERTY's clock. Run the
  // whole suite once locally and once under TZ=UTC — this assertion does not move
  // either way, because it never reads `Date`'s local getters.
  it("uses the property's own timezone, not the runner's, to decide what \"today\" is", () => {
    // 2026-01-15T23:00:00Z is still 15 Jan in UTC, but already 16 Jan thirteen
    // hours ahead in Kiritimati (UTC+14) — a 13+ hour gap, enough to land on a
    // different calendar day under almost any runner timezone, including UTC.
    const now = new Date('2026-01-15T23:00:00.000Z');
    const periods = [charge('2026-01-15'), charge('2026-01-16'), charge('2026-02-15')];

    expect(nextDuePeriodIndex(periods, 'Pacific/Kiritimati', now)).toBe(1);
    expect(nextDuePeriodIndex(periods, 'UTC', now)).toBe(0);
  });

  it('returns -1 once every period is already due', () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const periods = [charge('2026-01-15'), charge('2026-02-15')];

    expect(nextDuePeriodIndex(periods, 'UTC', now)).toBe(-1);
  });

  it('returns -1 for an empty schedule', () => {
    expect(nextDuePeriodIndex([], 'UTC', new Date('2026-01-01T00:00:00.000Z'))).toBe(-1);
  });
});
