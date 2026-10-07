import { describe, it, expect } from 'vitest';
import { addDays, compareIsoDate, type LeaseBillingTerms } from '@rms/contract';
import { ApiException } from './errors.js';
import {
  scheduleSanityMaxThrough,
  furthestBsScheduleDate,
  buildScheduleOrThrow,
  validateEndDateSchedulable,
} from './schedule.js';

/**
 * Regression coverage for the bug a live Docker run (not vitest) caught: Phase 2's
 * schedule routes 500'd for a Bikram Sambat lease whose 10-year sanity bound
 * (`calendar.addYears(startDate, 10)`) pushed the computed BS year past the data
 * table's ceiling, throwing `BsDateOutOfRangeError` before scheduling ever ran.
 * No existing `scheduleFixtures`-based test could see it: every fixture is
 * Gregorian, so the BS route was never exercised end to end.
 */

const bsTerms = (overrides: Partial<LeaseBillingTerms>): LeaseBillingTerms => ({
  frequency: 'monthly',
  rentCents: 100000,
  billingDay: 1,
  startDate: '2026-09-26', // BS2083-06-10
  endDate: null,
  ledgerStartDate: '2026-09-26',
  moveOutDate: null,
  moveOutBillingPolicy: 'bill_full_term',
  calendar: 'bikram_sambat',
  rentSteps: [],
  ...overrides,
});

describe('scheduleSanityMaxThrough — pure day-count arithmetic, never a calendar computation', () => {
  it('never throws for a Bikram Sambat startDate whose BS-year-plus-ten would exceed BS_MAX_YEAR', () => {
    // BS2083-06-10 + 10 Gregorian years in BS terms is BS2093 — past BS_MAX_YEAR
    // (2090). The OLD implementation (`calendar.addYears(startDate, 10)`) threw
    // BsDateOutOfRangeError right here, before any schedule was ever computed.
    expect(() => scheduleSanityMaxThrough('2026-09-26')).not.toThrow();
  });

  it('is calendar-independent: the Gregorian and the (nominal) BS answer for the same startDate are identical day arithmetic', () => {
    // There is no calendar parameter at all — this is the point. Prove it by
    // checking the result is exactly addDays(startDate, a fixed count), the same
    // for every caller regardless of which property.calendar it came from.
    const viaHelper = scheduleSanityMaxThrough('2026-01-01');
    const viaAddDays = addDays('2026-01-01', 3653);
    expect(viaHelper).toBe(viaAddDays);
  });

  it('reads as approximately ten years out', () => {
    const through = scheduleSanityMaxThrough('2026-01-01');
    expect(through.startsWith('2035') || through.startsWith('2036')).toBe(true);
  });
});

describe('furthestBsScheduleDate', () => {
  it('returns a date, computed from the contract (BS_MAX_YEAR + calendar exports), not a literal copied into apps/api', () => {
    const limit = furthestBsScheduleDate();
    expect(limit).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // bs-data.ts documents BS_MAX_YEAR = 2090 as AD 1943-04-14 .. 2034-04-13.
    expect(limit.startsWith('2034')).toBe(true);
  });

  it('is memoized — repeated calls return the identical value', () => {
    expect(furthestBsScheduleDate()).toBe(furthestBsScheduleDate());
  });
});

describe('validateEndDateSchedulable', () => {
  it('is a no-op for Gregorian, regardless of how far out endDate is', () => {
    expect(validateEndDateSchedulable('gregorian', '2099-12-31')).toBeNull();
  });

  it('is a no-op for a rolling (null) endDate on any calendar', () => {
    expect(validateEndDateSchedulable('bikram_sambat', null)).toBeNull();
  });

  it('allows a Bikram Sambat endDate on or before the table limit', () => {
    expect(validateEndDateSchedulable('bikram_sambat', furthestBsScheduleDate())).toBeNull();
  });

  it('refuses a Bikram Sambat endDate past the table limit, naming the real limit', () => {
    const limit = furthestBsScheduleDate();
    const pastLimit = addDays(limit, 1);
    const message = validateEndDateSchedulable('bikram_sambat', pastLimit);
    expect(message).not.toBeNull();
    expect(message).toContain(limit);
    expect(message).toMatch(/Bikram Sambat/);
  });
});

describe('buildScheduleOrThrow', () => {
  it('a BS lease whose schedule request would previously have thrown now succeeds', () => {
    // This is exactly the coordinator's reported scenario: BEFORE the fix, the
    // 10-year SANITY CHECK ITSELF threw `BsDateOutOfRangeError` while computing
    // `calendar.addYears(startDate, 10)` — unconditionally, before the requested
    // `through` was ever compared against it. A BS lease starting ~AD 2026 asking
    // for its NEXT YEAR's schedule (nowhere near any real range limit) 500'd for
    // that reason alone. It must now succeed.
    const terms = bsTerms({});
    const through = '2027-09-26'; // one BS year out — well inside the table either way
    expect(() => buildScheduleOrThrow(terms, through)).not.toThrow();
    const periods = buildScheduleOrThrow(terms, through);
    expect(periods.length).toBeGreaterThan(0);
  });

  it(
    'a BS lease early enough in the table can be scheduled all the way out to the full ' +
      '10-year sanity bound without hitting the real BS_MAX_YEAR limit',
    () => {
      const terms = bsTerms({ startDate: '1950-01-01', ledgerStartDate: '1950-01-01' });
      const through = scheduleSanityMaxThrough(terms.startDate); // 1950 + ~10y, nowhere near 2034
      expect(() => buildScheduleOrThrow(terms, through)).not.toThrow();
    },
  );

  it(
    'a BS lease starting late in the table (e.g. 2026) genuinely cannot be scheduled ' +
      'the FULL 10-year sanity bound out — that specific request correctly 422s, because ' +
      'the real table (through ~2034) is narrower than the generic 10-year sanity ceiling',
    () => {
      const terms = bsTerms({});
      const through = scheduleSanityMaxThrough(terms.startDate); // ~2036, past the BS table
      expect(() => buildScheduleOrThrow(terms, through)).toThrow(ApiException);
    },
  );

  it('a BS lease genuinely extending past the table returns a 422 ApiException, never a raw 500', () => {
    const limit = furthestBsScheduleDate();
    const pastLimit = addDays(limit, 400); // comfortably past the table's edge
    const terms = bsTerms({ startDate: '1950-01-01', ledgerStartDate: '1950-01-01' });

    let caught: unknown;
    try {
      buildScheduleOrThrow(terms, pastLimit);
      expect.unreachable('expected buildScheduleOrThrow to throw');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiException);
    const apiErr = caught as ApiException;
    expect(apiErr.status).toBe(422);
    expect(apiErr.toBody().error.details?.through?.[0]).toContain(limit);
    expect(apiErr.toBody().error.details?.through?.[0]).toMatch(/Bikram Sambat/);
  });

  it('never silently truncates the schedule at the range edge — it throws instead of returning a short, complete-looking array', () => {
    // Pinned explicitly per the coordinator's instruction: a short schedule that
    // LOOKS complete would under-bill with nobody noticing.
    const limit = furthestBsScheduleDate();
    const pastLimit = addDays(limit, 400);
    const terms = bsTerms({ startDate: '1950-01-01', ledgerStartDate: '1950-01-01' });
    expect(() => buildScheduleOrThrow(terms, pastLimit)).toThrow(ApiException);
  });

  it('the Gregorian path is unchanged: still throws the generic "too many periods" 422 for an absurd range, never the BS message', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      rentCents: 100000,
      billingDay: 1,
      startDate: '1900-01-01',
      endDate: null,
      ledgerStartDate: '1900-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
      rentSteps: [],
    };

    let caught: unknown;
    try {
      buildScheduleOrThrow(terms, '2900-01-01'); // MAX_SCHEDULE_PERIODS territory
      expect.unreachable('expected buildScheduleOrThrow to throw');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiException);
    const apiErr = caught as ApiException;
    expect(apiErr.status).toBe(422);
    expect(apiErr.toBody().error.details?.through?.[0]).not.toMatch(/Bikram Sambat/);
  });
});

describe('sanity: compareIsoDate ordering used by validateEndDateSchedulable', () => {
  it('the furthest BS date compares equal to itself', () => {
    expect(compareIsoDate(furthestBsScheduleDate(), furthestBsScheduleDate())).toBe(0);
  });
});
