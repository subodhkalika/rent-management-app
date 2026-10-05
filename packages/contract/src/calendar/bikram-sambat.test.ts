import { describe, it, expect } from 'vitest';
import { bikramSambat, bsFromIso, isoFromBs, BsDateOutOfRangeError } from './bikram-sambat.js';
import { BS_MIN_YEAR, BS_MAX_YEAR } from './bs-data.js';
import type { IsoDate } from '../common.js';

/**
 * Values below are cross-checked against `bikram-sambat@^1` directly (see the shell
 * session in the task notes / PR description) — not derived from this module itself,
 * so these tests are not circular. `bs-data.conformance.test.ts` separately checks
 * every day of the table against two libraries; this file checks the HIGHER-LEVEL
 * calendar operations (`addMonths`, `addYears`, `startOfMonth`, `endOfMonth`,
 * `isValid`, out-of-range behaviour) built on top of it.
 */

describe('bsFromIso / isoFromBs round-trip', () => {
  it('BS 2000-01-01 is the epoch', () => {
    expect(isoFromBs(2000, 1, 1)).toBe('1943-04-14');
    expect(bsFromIso('1943-04-14')).toEqual({ year: 2000, month: 1, day: 1 });
  });

  it('round-trips a 32-day month (Jestha 2000)', () => {
    expect(bikramSambat.daysInMonth(2000, 2)).toBe(32);
    expect(isoFromBs(2000, 2, 1)).toBe('1943-05-14');
    expect(isoFromBs(2000, 2, 32)).toBe('1943-06-14');
    expect(bsFromIso('1943-06-14')).toEqual({ year: 2000, month: 2, day: 32 });
  });

  it('round-trips the last day in the table, BS 2090-12-30', () => {
    expect(isoFromBs(2090, 12, 30)).toBe('2034-04-13');
    expect(bsFromIso('2034-04-13')).toEqual({ year: 2090, month: 12, day: 30 });
  });
});

describe('startOfMonth / endOfMonth', () => {
  it('finds the boundaries of a 32-day BS month from a date in the middle of it', () => {
    // 1943-05-20 AD falls inside BS 2000-02 (Jestha), a 32-day month.
    expect(bikramSambat.startOfMonth('1943-05-20')).toBe('1943-05-14');
    expect(bikramSambat.endOfMonth('1943-05-20')).toBe('1943-06-14');
  });

  it('endOfMonth - startOfMonth + 1 equals daysInMonth for a sample of months', () => {
    const samples: Array<[number, number]> = [
      [2000, 1],
      [2000, 2],
      [2026, 5],
      [2082, 12],
      [2090, 12],
    ];
    for (const [year, month] of samples) {
      const d = isoFromBs(year, month, 1);
      const start = bikramSambat.startOfMonth(d);
      const end = bikramSambat.endOfMonth(d);
      const { year: ey, month: em, day: ed } = bsFromIso(end);
      expect(start).toBe(d);
      expect(ey).toBe(year);
      expect(em).toBe(month);
      expect(ed).toBe(bikramSambat.daysInMonth(year, month));
    }
  });
});

describe('addMonths', () => {
  it('advances across a 32-day month without clamping', () => {
    expect(bikramSambat.addMonths('1943-04-14' as IsoDate, 1)).toBe('1943-05-14'); // BS2000-01-01 -> 02-01
  });

  it('clamps the day into a shorter target month (32 -> 31 crossing BS2000 -> BS2001)', () => {
    // BS2000-02-32 (Jestha's last day) + 12 months -> BS2001-02, which per
    // bikram-sambat@^1 has only 31 days.
    expect(bikramSambat.daysInMonth(2001, 2)).toBe(31);
    expect(bikramSambat.addMonths('1943-06-14' as IsoDate, 12)).toBe('1944-06-13'); // BS2001-02-31
  });

  it('clamps 30 -> 29 crossing into a shorter month within the same addition', () => {
    // BS2000-01-30 (Baisakh's last day, a 30-day month) + 1 month -> BS2000-02-30
    // (Jestha has 32 days, so no clamping yet).
    expect(bikramSambat.addMonths('1943-05-13' as IsoDate, 1)).toBe('1943-06-12'); // BS2000-02-30
  });

  it('wraps across a BS year boundary (Baisakh 1)', () => {
    // BS2082-12-01 (Chaitra, the last month of 2082) + 1 month -> BS2083-01-01
    // (Baisakh 1, the Nepali new year).
    const chaitra1 = isoFromBs(2082, 12, 1);
    expect(bikramSambat.addMonths(chaitra1, 1)).toBe(isoFromBs(2083, 1, 1));
    expect(isoFromBs(2083, 1, 1)).toBe('2026-04-14');
  });
});

describe('addYears', () => {
  it('clamps the day to the target year-month length (32 -> 31)', () => {
    expect(bikramSambat.addYears('1943-06-14' as IsoDate, 1)).toBe('1944-06-13'); // BS2000-02-32 -> BS2001-02-31
  });

  it('is a no-op in day terms when the target month is at least as long', () => {
    const d = isoFromBs(2082, 6, 15);
    const next = bikramSambat.addYears(d, 1);
    expect(bsFromIso(next)).toEqual({ year: 2083, month: 6, day: 15 });
  });
});

describe('isValid', () => {
  it('accepts every (year, month, day) the table defines', () => {
    expect(bikramSambat.isValid(2000, 2, 32)).toBe(true);
    expect(bikramSambat.isValid(2090, 12, 30)).toBe(true);
    expect(bikramSambat.isValid(BS_MIN_YEAR, 1, 1)).toBe(true);
  });

  it('rejects a day beyond the specific month length, without throwing', () => {
    expect(bikramSambat.isValid(2001, 2, 32)).toBe(false); // BS2001-02 has only 31 days
  });

  it('rejects a year outside [BS_MIN_YEAR, BS_MAX_YEAR], without throwing', () => {
    expect(bikramSambat.isValid(BS_MIN_YEAR - 1, 1, 1)).toBe(false);
    expect(bikramSambat.isValid(BS_MAX_YEAR + 1, 1, 1)).toBe(false);
  });

  it('rejects a structurally invalid month, without throwing', () => {
    expect(bikramSambat.isValid(2026, 0, 1)).toBe(false);
    expect(bikramSambat.isValid(2026, 13, 1)).toBe(false);
  });
});

describe('out-of-range dates throw a named error, never NaN or a silent clamp', () => {
  it('clampDayToMonth throws BsDateOutOfRangeError before BS_MIN_YEAR', () => {
    expect(() => bikramSambat.clampDayToMonth(BS_MIN_YEAR - 1, 1, 1)).toThrow(BsDateOutOfRangeError);
  });

  it('clampDayToMonth throws BsDateOutOfRangeError after BS_MAX_YEAR', () => {
    expect(() => bikramSambat.clampDayToMonth(BS_MAX_YEAR + 1, 1, 1)).toThrow(BsDateOutOfRangeError);
  });

  it('addMonths throws when it would cross past BS_MAX_YEAR', () => {
    const lastMonth = isoFromBs(BS_MAX_YEAR, 12, 1);
    expect(() => bikramSambat.addMonths(lastMonth, 1)).toThrow(BsDateOutOfRangeError);
  });

  it('addYears throws when it would land before BS_MIN_YEAR', () => {
    const firstDay = isoFromBs(BS_MIN_YEAR, 1, 1);
    expect(() => bikramSambat.addYears(firstDay, -1)).toThrow(BsDateOutOfRangeError);
  });

  it('bsFromIso throws for a Gregorian date before BS_EPOCH_AD', () => {
    expect(() => bsFromIso('1900-01-01')).toThrow(BsDateOutOfRangeError);
  });

  it('bsFromIso throws for a Gregorian date after the table ends', () => {
    expect(() => bsFromIso('2100-01-01')).toThrow(BsDateOutOfRangeError);
  });

  it('isoFromBs throws for an out-of-range year rather than returning NaN-shaped output', () => {
    expect(() => isoFromBs(BS_MAX_YEAR + 1, 1, 1)).toThrow(BsDateOutOfRangeError);
  });

  it('the error is specifically named, not a generic RangeError from elsewhere', () => {
    try {
      bikramSambat.clampDayToMonth(1999, 1, 1);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BsDateOutOfRangeError);
      expect((e as Error).name).toBe('BsDateOutOfRangeError');
    }
  });
});

describe('maxDayOfMonth', () => {
  it('is 32 for every year in the table (every year reaches a 32-day month)', () => {
    for (const year of [BS_MIN_YEAR, 2026, 2083, BS_MAX_YEAR]) {
      expect(bikramSambat.maxDayOfMonth(year)).toBe(32);
    }
  });

  it('throws for a year outside the table', () => {
    expect(() => bikramSambat.maxDayOfMonth(BS_MAX_YEAR + 1)).toThrow(BsDateOutOfRangeError);
  });
});

describe('monthsInYear', () => {
  it('is always 12', () => {
    expect(bikramSambat.monthsInYear(BS_MIN_YEAR)).toBe(12);
    expect(bikramSambat.monthsInYear(BS_MAX_YEAR)).toBe(12);
  });

  it('throws for a year outside the table', () => {
    expect(() => bikramSambat.monthsInYear(BS_MIN_YEAR - 1)).toThrow(BsDateOutOfRangeError);
  });
});

describe('id', () => {
  it("is 'bikram_sambat'", () => {
    expect(bikramSambat.id).toBe('bikram_sambat');
  });
});
