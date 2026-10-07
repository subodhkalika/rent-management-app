import { describe, it, expect } from 'vitest';
import {
  buildSchedule,
  dueDateFor,
  validateBillingTerms,
  compareIsoDate,
  rentForPeriodStart,
  generateRentSteps,
  type LeaseBillingTerms,
} from './billing.js';
import { bsScheduleFixtures, bsDueDateFixtures, bsYearlyFixture, bsGeneratorFixtures } from './billing.bs.fixtures.js';
import { MAX_BILLING_DAY } from './calendar/index.js';

/**
 * The BS counterpart of `billing.test.ts`'s fixture-driven suite — proves the seam
 * added in task 006b actually routes `buildSchedule`/`dueDateFor` through the
 * `Calendar` interface end to end, not just that `calendar/bikram-sambat.ts` is
 * correct in isolation (that is `bikram-sambat.test.ts` /
 * `bs-data.conformance.test.ts`'s job).
 */

describe('buildSchedule — Bikram Sambat fixtures', () => {
  it.each(bsScheduleFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(buildSchedule(fixture.terms, fixture.through)).toEqual(fixture.expected);
  });

  it('BSb3 yearly lease spanning Baisakh 1', () => {
    expect(buildSchedule(bsYearlyFixture.terms, bsYearlyFixture.through)).toEqual(bsYearlyFixture.expected);
  });
});

describe('dueDateFor — Bikram Sambat fixtures', () => {
  it.each(bsDueDateFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(dueDateFor(fixture.input)).toBe(fixture.expected);
  });
});

describe('invariants hold for BS schedules too (I2, I4, I5, I6, I7)', () => {
  const allFixtures = [...bsScheduleFixtures, bsYearlyFixture];
  for (const fixture of allFixtures) {
    describe(fixture.name, () => {
      const charges = buildSchedule(fixture.terms, fixture.through);

      it('I2 amountCents is always an integer', () => {
        for (const c of charges) expect(Number.isInteger(c.amountCents)).toBe(true);
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

      it("I7' a full period charges exactly rentForPeriodStart(terms, periodStart)", () => {
        for (const c of charges) {
          if (c.daysOccupied === c.daysInPeriod) {
            expect(c.amountCents).toBe(rentForPeriodStart(fixture.terms, c.periodStart));
          }
        }
      });
    });
  }
});

describe('generateRentSteps — Bikram Sambat fixture (G6)', () => {
  it.each(bsGeneratorFixtures.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    expect(generateRentSteps(fixture.input)).toEqual(fixture.expected);
  });

  it('produces a ladder validateBillingTerms accepts', () => {
    for (const fixture of bsGeneratorFixtures) {
      const terms: LeaseBillingTerms = {
        frequency: fixture.input.frequency,
        calendar: fixture.input.calendar,
        rentCents: fixture.input.baseRentCents,
        billingDay: 1,
        startDate: fixture.input.startDate,
        endDate: fixture.input.endDate,
        ledgerStartDate: fixture.input.startDate,
        moveOutDate: null,
        moveOutBillingPolicy: 'bill_full_term',
        rentSteps: fixture.expected.map((s) => ({ effectiveFrom: s.effectiveFrom, rentCents: s.rentCents })),
      };
      expect(validateBillingTerms(terms)).toBeNull();
    }
  });

  it('is deterministic', () => {
    for (const fixture of bsGeneratorFixtures) {
      expect(generateRentSteps(fixture.input)).toEqual(generateRentSteps(fixture.input));
    }
  });
});

describe('validateBillingTerms — calendar-specific billingDay ceiling', () => {
  const base: LeaseBillingTerms = {
    frequency: 'monthly',
    rentCents: 100000,
    billingDay: 1,
    startDate: '1943-04-14',
    endDate: null,
    ledgerStartDate: '1943-04-14',
    moveOutDate: null,
    moveOutBillingPolicy: 'bill_full_term',
    calendar: 'bikram_sambat',
    rentSteps: [],
  };

  it('accepts billingDay 32 for a Bikram Sambat lease', () => {
    expect(validateBillingTerms({ ...base, billingDay: 32 })).toBeNull();
  });

  it('rejects billingDay exceeding 32 even for Bikram Sambat', () => {
    expect(MAX_BILLING_DAY.bikram_sambat).toBe(32);
    // The contract's `.max(32)` already rejects anything above 32 at the schema
    // layer; this exercises `validateBillingTerms`'s own independent check.
    expect(validateBillingTerms({ ...base, billingDay: 33 as unknown as number })).not.toBeNull();
  });

  it('rejects billingDay 32 for a Gregorian lease — the hard requirement', () => {
    const gregorian: LeaseBillingTerms = { ...base, calendar: 'gregorian', billingDay: 32, startDate: '2026-01-01', ledgerStartDate: '2026-01-01' };
    expect(validateBillingTerms(gregorian)).not.toBeNull();
  });

  it('accepts billingDay 31 for a Gregorian lease', () => {
    const gregorian: LeaseBillingTerms = { ...base, calendar: 'gregorian', billingDay: 31, startDate: '2026-01-01', ledgerStartDate: '2026-01-01' };
    expect(validateBillingTerms(gregorian)).toBeNull();
  });
});
