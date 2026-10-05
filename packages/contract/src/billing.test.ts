import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  isLeapYear,
  daysInMonth,
  parseIsoDate,
  toIsoDate,
  clampDayToMonth,
  addDays,
  addMonths,
  addYears,
  compareIsoDate,
  daysBetweenInclusive,
  minIsoDate,
  maxIsoDate,
  clampIsoDate,
  periodContaining,
  periodsOverlapping,
  isPeriodStart,
  dueDateFor,
  prorate,
  buildSchedule,
  generationHorizon,
  chargesDueForGeneration,
  validateBillingTerms,
  effectiveBillingEnd,
  GENERATION_LOOKAHEAD_DAYS,
  MAX_SCHEDULE_PERIODS,
  type LeaseBillingTerms,
} from './billing.js';
import {
  scheduleFixtures,
  dueDateFixtures,
  prorationFixtures,
  generationFixtures,
  billingEndFixtures,
} from './billing.fixtures.js';
import type { IsoDate } from './common.js';

/* ======================================================================== */
/* I1 — purity: a source-grep over billing.ts                               */
/* ======================================================================== */

describe('I1 purity', () => {
  const thisFile = fileURLToPath(import.meta.url);
  const billingSource = readFileSync(join(dirname(thisFile), 'billing.ts'), 'utf-8');

  it('never calls Date.now()', () => {
    expect(billingSource).not.toMatch(/Date\.now\(/);
  });

  it('never constructs a zero-argument new Date()', () => {
    expect(billingSource).not.toMatch(/new Date\(\s*\)/);
  });

  it('never references Intl', () => {
    expect(billingSource).not.toMatch(/\bIntl\./);
  });

  it('never constructs a Date object at all', () => {
    // Stronger than the plan requires: this file does all calendar arithmetic as
    // plain (year, month, day) integer triples, so there is no legitimate `new
    // Date(` anywhere, not even with arguments.
    expect(billingSource).not.toMatch(/new Date\(/);
  });
});

/* ======================================================================== */
/* Calendar primitives                                                      */
/* ======================================================================== */

describe('isLeapYear', () => {
  it.each([
    [2026, false],
    [2028, true],
    [2000, true],
    [2100, false],
    [1900, false],
    [2400, true],
  ])('%i -> %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });
});

describe('daysInMonth', () => {
  it('handles February across leap rules', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it('handles 30/31-day months', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
  });
});

describe('toIsoDate', () => {
  it('round-trips a valid date', () => {
    expect(toIsoDate(2026, 2, 28)).toBe('2026-02-28');
  });

  it('throws on an impossible date', () => {
    expect(() => toIsoDate(2026, 2, 30)).toThrow(RangeError);
    expect(() => toIsoDate(2026, 13, 1)).toThrow(RangeError);
    expect(() => toIsoDate(2026, 0, 1)).toThrow(RangeError);
  });
});

describe('parseIsoDate', () => {
  it('extracts year/month/day', () => {
    expect(parseIsoDate('2026-03-15')).toEqual({ year: 2026, month: 3, day: 15 });
  });
});

describe('clampDayToMonth', () => {
  it.each([
    [2026, 2, 31, '2026-02-28'],
    [2028, 2, 31, '2028-02-29'],
    [2100, 2, 31, '2100-02-28'],
    [2000, 2, 29, '2000-02-29'],
    [2026, 4, 31, '2026-04-30'],
    [2026, 1, 15, '2026-01-15'],
  ])('(%i, %i, %i) -> %s', (y, m, d, expected) => {
    expect(clampDayToMonth(y, m, d)).toBe(expected);
  });
});

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('crosses a non-leap February', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('crosses a leap February', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('goes backward', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('addMonths', () => {
  it('clamps the day to the target month length', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('wraps across a year boundary', () => {
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -2)).toBe('2025-11-15');
  });
});

describe('addYears', () => {
  it('clamps Feb 29 to Feb 28 in a non-leap year', () => {
    expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
  });

  it('is a no-op shift on a normal date', () => {
    expect(addYears('2026-04-01', 3)).toBe('2029-04-01');
  });
});

describe('compareIsoDate / min / max / clamp', () => {
  it('compares chronologically', () => {
    expect(compareIsoDate('2026-01-01', '2026-01-02')).toBe(-1);
    expect(compareIsoDate('2026-01-02', '2026-01-01')).toBe(1);
    expect(compareIsoDate('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('min/max pick correctly among 3+', () => {
    expect(minIsoDate('2026-03-01', '2026-01-01', '2026-02-01')).toBe('2026-01-01');
    expect(maxIsoDate('2026-03-01', '2026-01-01', '2026-02-01')).toBe('2026-03-01');
  });

  it('clamp is a no-op inside the range', () => {
    expect(clampIsoDate('2026-02-01', '2026-01-01', '2026-03-01')).toBe('2026-02-01');
  });

  it('clamp floors below lo and ceils above hi', () => {
    expect(clampIsoDate('2025-12-01', '2026-01-01', '2026-03-01')).toBe('2026-01-01');
    expect(clampIsoDate('2026-04-01', '2026-01-01', '2026-03-01')).toBe('2026-03-01');
  });
});

describe('daysBetweenInclusive', () => {
  it('counts inclusively', () => {
    expect(daysBetweenInclusive('2026-01-01', '2026-01-31')).toBe(31);
    expect(daysBetweenInclusive('2026-01-01', '2026-01-01')).toBe(1);
  });

  it('is 0 when to < from', () => {
    expect(daysBetweenInclusive('2026-01-05', '2026-01-01')).toBe(0);
  });
});

/* ======================================================================== */
/* Periods                                                                   */
/* ======================================================================== */

describe('periodContaining — monthly', () => {
  it('index 0 is the anchor month', () => {
    const p = periodContaining('monthly', '2026-03-15', '2026-03-20');
    expect(p).toEqual({ index: 0, start: '2026-03-01', end: '2026-03-31' });
  });

  it('supports negative indices', () => {
    const p = periodContaining('monthly', '2026-03-15', '2026-01-10');
    expect(p.index).toBe(-2);
    expect(p.start).toBe('2026-01-01');
    expect(p.end).toBe('2026-01-31');
  });
});

describe('periodContaining — yearly', () => {
  it('index 0 is the anchor year', () => {
    const p = periodContaining('yearly', '2026-04-01', '2026-10-01');
    expect(p).toEqual({ index: 0, start: '2026-04-01', end: '2027-03-31' });
  });

  it('handles the leap-day anchor (F8)', () => {
    const p1 = periodContaining('yearly', '2028-02-29', '2028-02-29');
    expect(p1).toEqual({ index: 0, start: '2028-02-29', end: '2029-02-27' });
    const p2 = periodContaining('yearly', '2028-02-29', '2029-02-28');
    expect(p2).toEqual({ index: 1, start: '2029-02-28', end: '2030-02-27' });
  });

  it('supports negative indices', () => {
    const p = periodContaining('yearly', '2026-04-01', '2024-06-01');
    expect(p.index).toBe(-2);
  });
});

describe('isPeriodStart', () => {
  it('true on a period start, false elsewhere', () => {
    expect(isPeriodStart('monthly', '2026-01-01', '2026-03-01')).toBe(true);
    expect(isPeriodStart('monthly', '2026-01-01', '2026-03-02')).toBe(false);
    expect(isPeriodStart('yearly', '2026-04-01', '2027-04-01')).toBe(true);
    expect(isPeriodStart('yearly', '2026-04-01', '2027-04-02')).toBe(false);
  });
});

describe('I11 periodsOverlapping — contiguous, gapless, non-overlapping cover', () => {
  function assertContiguousCover(periods: ReturnType<typeof periodsOverlapping>): void {
    for (let i = 1; i < periods.length; i += 1) {
      const prev = periods[i - 1]!;
      const curr = periods[i]!;
      expect(curr.index).toBe(prev.index + 1);
      expect(addDays(prev.end, 1)).toBe(curr.start);
      expect(compareIsoDate(curr.start, curr.end)).toBeLessThanOrEqual(0);
    }
  }

  it('monthly, spanning a whole year', () => {
    const periods = periodsOverlapping('monthly', '2026-01-01', '2026-01-01', '2026-12-31');
    expect(periods).toHaveLength(12);
    assertContiguousCover(periods);
  });

  it('monthly, across a leap-year February boundary', () => {
    const periods = periodsOverlapping('monthly', '2028-01-01', '2028-01-15', '2028-03-15');
    expect(periods.map((p) => p.end)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    assertContiguousCover(periods);
  });

  it('yearly, across the leap-day anchor boundary', () => {
    const periods = periodsOverlapping('yearly', '2028-02-29', '2028-02-29', '2031-02-27');
    expect(periods).toHaveLength(3);
    assertContiguousCover(periods);
  });

  it('is empty when from > to', () => {
    expect(periodsOverlapping('monthly', '2026-01-01', '2026-03-01', '2026-01-01')).toEqual([]);
  });
});

/* ======================================================================== */
/* Due date fixtures                                                        */
/* ======================================================================== */

describe('dueDateFor — fixtures', () => {
  it.each(dueDateFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(dueDateFor(fixture.input)).toBe(fixture.expected);
  });
});

/* ======================================================================== */
/* Proration fixtures                                                       */
/* ======================================================================== */

describe('prorate — fixtures', () => {
  it.each(prorationFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(prorate(fixture.rentCents, fixture.daysOccupied, fixture.daysInPeriod)).toBe(fixture.expected);
  });

  it('every fixture result is an integer (I2)', () => {
    for (const f of prorationFixtures) {
      expect(Number.isInteger(prorate(f.rentCents, f.daysOccupied, f.daysInPeriod))).toBe(true);
    }
  });
});

/* ======================================================================== */
/* effectiveBillingEnd / billingEndFixtures                                  */
/* ======================================================================== */

describe('effectiveBillingEnd — fixtures', () => {
  it.each(billingEndFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(effectiveBillingEnd(fixture.terms)).toBe(fixture.expected);
  });
});

describe('I13 effectiveBillingEnd can only shorten', () => {
  it('never exceeds endDate, for both policies, across billingEndFixtures', () => {
    for (const f of billingEndFixtures) {
      if (f.terms.endDate !== null) {
        const result = effectiveBillingEnd(f.terms);
        expect(result).not.toBeNull();
        expect(compareIsoDate(result as IsoDate, f.terms.endDate)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('never exceeds endDate, across every schedule fixture, under an arbitrary move-out', () => {
    for (const f of scheduleFixtures) {
      if (f.terms.endDate === null) continue;
      for (const moveOutDate of ['2020-01-01', '2026-06-01', '2099-01-01'] as const) {
        for (const policy of ['bill_full_term', 'stop_at_move_out'] as const) {
          const terms: LeaseBillingTerms = { ...f.terms, moveOutDate, moveOutBillingPolicy: policy };
          const result = effectiveBillingEnd(terms);
          expect(result).not.toBeNull();
          expect(compareIsoDate(result as IsoDate, f.terms.endDate)).toBeLessThanOrEqual(0);
        }
      }
    }
  });
});

/* ======================================================================== */
/* Schedule fixtures                                                        */
/* ======================================================================== */

describe('buildSchedule — fixtures', () => {
  it.each(scheduleFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(buildSchedule(fixture.terms, fixture.through)).toEqual(fixture.expected);
  });
});

describe('generation fixtures (F11, F12)', () => {
  it.each(generationFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const charges = chargesDueForGeneration(fixture.terms, fixture.today);
    expect(charges.map((c) => c.generationKey)).toEqual(fixture.expectedKeys);
  });
});

/* ======================================================================== */
/* Property tests across every fixture: I2, I4, I5, I6, I7                  */
/* ======================================================================== */

describe('invariants over every schedule fixture', () => {
  for (const fixture of scheduleFixtures) {
    describe(fixture.name, () => {
      const charges = buildSchedule(fixture.terms, fixture.through);

      it('I2 amountCents is always an integer', () => {
        for (const c of charges) expect(Number.isInteger(c.amountCents)).toBe(true);
      });

      it('I3 generationKey === periodStart, unique per schedule', () => {
        const keys = charges.map((c) => c.generationKey);
        expect(new Set(keys).size).toBe(keys.length);
        for (const c of charges) expect(c.generationKey).toBe(c.periodStart);
      });

      it('I4 periodStart <= occupiedStart <= occupiedEnd <= periodEnd', () => {
        for (const c of charges) {
          expect(compareIsoDate(c.periodStart, c.occupiedStart)).toBeLessThanOrEqual(0);
          expect(compareIsoDate(c.occupiedStart, c.occupiedEnd)).toBeLessThanOrEqual(0);
          expect(compareIsoDate(c.occupiedEnd, c.periodEnd)).toBeLessThanOrEqual(0);
        }
      });

      it('I5 dueDate is within [occupiedStart, occupiedEnd]', () => {
        for (const c of charges) {
          expect(compareIsoDate(c.occupiedStart, c.dueDate)).toBeLessThanOrEqual(0);
          expect(compareIsoDate(c.dueDate, c.occupiedEnd)).toBeLessThanOrEqual(0);
        }
      });

      it('I6 isProrated === (daysOccupied < daysInPeriod)', () => {
        for (const c of charges) expect(c.isProrated).toBe(c.daysOccupied < c.daysInPeriod);
      });

      it('I7 a full period charges exactly rentCents', () => {
        for (const c of charges) {
          if (c.daysOccupied === c.daysInPeriod) {
            expect(c.amountCents).toBe(fixture.terms.rentCents);
          }
        }
      });
    });
  }
});

/* ======================================================================== */
/* I8 / I9 — monotonicity in `through`                                      */
/* ======================================================================== */

describe('I8 / I9 monotonicity: buildSchedule(t, X) is a strict prefix of buildSchedule(t, Y) for X <= Y', () => {
  for (const fixture of scheduleFixtures) {
    it(fixture.name, () => {
      const full = buildSchedule(fixture.terms, fixture.through);
      if (full.length === 0) return;

      // Three `through` values per fixture: earlier than the last entry, exactly the
      // fixture's own `through`, and well beyond it.
      const midIndex = Math.floor(full.length / 2);
      const midThrough = full[midIndex]!.periodStart;
      const beyondThrough = addDays(fixture.through, 400);

      const shortSchedule = buildSchedule(fixture.terms, midThrough);
      const exactSchedule = buildSchedule(fixture.terms, fixture.through);
      const longSchedule = buildSchedule(fixture.terms, beyondThrough);

      // shortSchedule is a strict prefix of exactSchedule
      for (let i = 0; i < shortSchedule.length; i += 1) {
        expect(shortSchedule[i]).toEqual(exactSchedule[i]);
      }
      expect(shortSchedule.length).toBeLessThanOrEqual(exactSchedule.length);

      // exactSchedule is a prefix of longSchedule, UNLESS the lease has a billing end
      // (endDate or a stopped move-out) at or before `beyondThrough`, in which case the
      // two are identical — `through` beyond the lease's own end adds nothing (I9).
      for (let i = 0; i < exactSchedule.length; i += 1) {
        expect(exactSchedule[i]).toEqual(longSchedule[i]);
      }
      expect(exactSchedule.length).toBeLessThanOrEqual(longSchedule.length);
    });
  }
});

/* ======================================================================== */
/* I10 — chargesDueForGeneration === buildSchedule(terms, generationHorizon) */
/* ======================================================================== */

describe('I10 chargesDueForGeneration is the same code path as buildSchedule', () => {
  it('generationHorizon adds exactly GENERATION_LOOKAHEAD_DAYS', () => {
    expect(generationHorizon('2026-01-01')).toBe(addDays('2026-01-01', GENERATION_LOOKAHEAD_DAYS));
  });

  for (const fixture of generationFixtures) {
    it(fixture.name, () => {
      const viaGeneration = chargesDueForGeneration(fixture.terms, fixture.today);
      const viaBuildSchedule = buildSchedule(fixture.terms, generationHorizon(fixture.today));
      expect(viaGeneration).toEqual(viaBuildSchedule);
    });
  }
});

/* ======================================================================== */
/* I12 — periodIndex is anchored, not the array index (pinned by F9)        */
/* ======================================================================== */

describe('I12 periodIndex is anchored to the lease\'s first natural period', () => {
  it('F9 pins the first generated entry at periodIndex 9', () => {
    const f9 = scheduleFixtures.find((f) => f.name.startsWith('F9'));
    expect(f9).toBeDefined();
    expect(f9!.expected[0]!.periodIndex).toBe(9);
    // and it is NOT the array index:
    expect(f9!.expected[0]!.periodIndex).not.toBe(0);
  });
});

/* ======================================================================== */
/* I14 — under bill_full_term, output is independent of moveOutDate          */
/* ======================================================================== */

describe('I14 under bill_full_term, buildSchedule output is independent of moveOutDate', () => {
  for (const fixture of scheduleFixtures) {
    it(fixture.name, () => {
      const baseline = buildSchedule(
        { ...fixture.terms, moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
        fixture.through,
      );
      for (const moveOutDate of ['2020-01-01', '2026-06-01', '2099-01-01'] as const) {
        const withMoveOut = buildSchedule(
          { ...fixture.terms, moveOutDate, moveOutBillingPolicy: 'bill_full_term' },
          fixture.through,
        );
        expect(withMoveOut).toEqual(baseline);
      }
    });
  }
});

/* ======================================================================== */
/* validateBillingTerms                                                     */
/* ======================================================================== */

describe('validateBillingTerms', () => {
  const base: LeaseBillingTerms = {
    frequency: 'monthly',
    rentCents: 100000,
    billingDay: 1,
    startDate: '2026-01-01',
    endDate: null,
    ledgerStartDate: '2026-01-01',
    moveOutDate: null,
    moveOutBillingPolicy: 'bill_full_term',
  };

  it('accepts valid terms', () => {
    expect(validateBillingTerms(base)).toBeNull();
  });

  it('rejects endDate before startDate', () => {
    expect(validateBillingTerms({ ...base, endDate: '2025-12-31' })).not.toBeNull();
  });

  it('rejects ledgerStartDate before startDate', () => {
    expect(validateBillingTerms({ ...base, ledgerStartDate: '2025-12-01' })).not.toBeNull();
  });

  it('rejects ledgerStartDate after endDate', () => {
    expect(
      validateBillingTerms({ ...base, endDate: '2026-02-01', ledgerStartDate: '2026-03-01' }),
    ).not.toBeNull();
  });

  it('rejects a ledgerStartDate that is not a period start (decision #8)', () => {
    expect(validateBillingTerms({ ...base, ledgerStartDate: '2026-02-15' })).not.toBeNull();
  });

  it('accepts a ledgerStartDate that equals startDate', () => {
    expect(validateBillingTerms({ ...base, ledgerStartDate: '2026-01-01' })).toBeNull();
  });

  it('accepts a ledgerStartDate that is a later period start', () => {
    expect(validateBillingTerms({ ...base, ledgerStartDate: '2026-03-01' })).toBeNull();
  });

  it('rejects moveOutDate before startDate (Amendment A.2)', () => {
    expect(validateBillingTerms({ ...base, moveOutDate: '2025-06-01' })).not.toBeNull();
  });

  it('accepts moveOutDate on or after startDate', () => {
    expect(validateBillingTerms({ ...base, moveOutDate: '2026-01-01' })).toBeNull();
    expect(validateBillingTerms({ ...base, moveOutDate: '2026-06-01' })).toBeNull();
  });
});

/* ======================================================================== */
/* MAX_SCHEDULE_PERIODS                                                      */
/* ======================================================================== */

describe('MAX_SCHEDULE_PERIODS', () => {
  it('throws RangeError past the limit', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      rentCents: 100000,
      billingDay: 1,
      startDate: '2000-01-01',
      endDate: null,
      ledgerStartDate: '2000-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
    };
    // 601 months past 2000-01-01 is well past MAX_SCHEDULE_PERIODS (600).
    const farThrough = addMonths('2000-01-01', MAX_SCHEDULE_PERIODS + 5);
    expect(() => buildSchedule(terms, farThrough)).toThrow(RangeError);
  });

  it('does not throw at exactly the limit', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      rentCents: 100000,
      billingDay: 1,
      startDate: '2000-01-01',
      endDate: null,
      ledgerStartDate: '2000-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
    };
    const through = addMonths('2000-01-01', MAX_SCHEDULE_PERIODS - 1);
    expect(() => buildSchedule(terms, through)).not.toThrow();
  });
});
