import { describe, expect, it } from 'vitest';
import { buildSchedule, type LeaseBillingTerms, type PlannedCharge } from '@rms/contract';
import { groupScheduleByAmount, scheduleTotalCents, labelForGroup } from './schedule-summary';

/** A three-year monthly lease, prorated at both ends — the exact shape from the
 *  product feedback: a short stub to move in, 34 identical full months, a short
 *  stub to move out. */
const threeYearTerms: LeaseBillingTerms = {
  frequency: 'monthly',
  calendar: 'gregorian',
  rentCents: 500000,
  billingDay: 1,
  startDate: '2023-01-15',
  endDate: '2025-12-10',
  ledgerStartDate: '2023-01-15',
  moveOutDate: null,
  moveOutBillingPolicy: 'bill_full_term',
};

function buildThreeYearSchedule(): PlannedCharge[] {
  return buildSchedule(threeYearTerms, '2025-12-10');
}

describe('groupScheduleByAmount', () => {
  it('collapses a long single-rate run to a small number of groups, and the prorated ends never join it', () => {
    const periods = buildThreeYearSchedule();
    expect(periods.length).toBeGreaterThan(30); // confirms this really is the "longgg table" case

    const groups = groupScheduleByAmount(periods);

    // prorated-first, one run, prorated-last — three groups, not thirty-six rows.
    expect(groups).toHaveLength(3);
    expect(groups[0]!.periods).toHaveLength(1);
    expect(groups[0]!.periods[0]!.isProrated).toBe(true);
    expect(groups[2]!.periods).toHaveLength(1);
    expect(groups[2]!.periods[0]!.isProrated).toBe(true);

    const middle = groups[1]!;
    expect(middle.periods.length).toBe(periods.length - 2);
    expect(middle.periods.every((p) => !p.isProrated)).toBe(true);
    expect(new Set(middle.periods.map((p) => p.amountCents)).size).toBe(1);
  });

  it('expanding the collapsed groups reveals every period, unchanged', () => {
    const periods = buildThreeYearSchedule();
    const groups = groupScheduleByAmount(periods);

    const expanded = groups.flatMap((g) => g.periods);
    expect(expanded).toEqual(periods);
  });

  it('never collapses a prorated period into a neighbouring run, even if the amount happens to match', () => {
    // A contrived schedule where a prorated period's rounded amount happens to
    // equal the full-period amount next to it — grouping must still key off
    // `isProrated`, not just numeric equality.
    const full: PlannedCharge = {
      generationKey: '2026-02-01',
      periodIndex: 1,
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      occupiedStart: '2026-02-01',
      occupiedEnd: '2026-02-28',
      daysOccupied: 28,
      daysInPeriod: 28,
      dueDate: '2026-02-01',
      amountCents: 100000,
      isProrated: false,
    };
    const proratedButSameAmount: PlannedCharge = {
      generationKey: '2026-01-01',
      periodIndex: 0,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      occupiedStart: '2026-01-01',
      occupiedEnd: '2026-01-31',
      daysOccupied: 31,
      daysInPeriod: 31,
      dueDate: '2026-01-01',
      amountCents: 100000,
      isProrated: true,
    };

    const groups = groupScheduleByAmount([proratedButSameAmount, full]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.periods).toHaveLength(1);
    expect(groups[0]!.periods[0]!.isProrated).toBe(true);
  });

  it('renders a single-period lease as one group', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      calendar: 'gregorian',
      rentCents: 100000,
      billingDay: 1,
      startDate: '2026-03-05',
      endDate: '2026-03-20',
      ledgerStartDate: '2026-03-05',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
    };
    const periods = buildSchedule(terms, '2026-12-01');
    expect(periods).toHaveLength(1);

    const groups = groupScheduleByAmount(periods);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.periods).toEqual(periods);
  });

  it('a clean lease with no proration and one rate collapses to a single group', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      calendar: 'gregorian',
      rentCents: 150000,
      billingDay: 1,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      ledgerStartDate: '2026-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
    };
    const periods = buildSchedule(terms, '2026-12-01');
    expect(periods.length).toBeGreaterThan(1);

    const groups = groupScheduleByAmount(periods);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.periods).toEqual(periods);
  });
});

describe('scheduleTotalCents', () => {
  it('equals the sum of every period in the FULL schedule, asserted independently of the grouping', () => {
    const periods = buildThreeYearSchedule();
    const expected = periods.reduce((sum, p) => sum + p.amountCents, 0);
    expect(scheduleTotalCents(periods)).toBe(expected);
    // Not a tautology against the function under test: recompute by hand too.
    expect(scheduleTotalCents(periods)).toBe(
      periods.map((p) => p.amountCents).reduce((a, b) => a + b, 0),
    );
  });

  it('is unaffected by how the schedule happens to group', () => {
    const periods = buildThreeYearSchedule();
    const groups = groupScheduleByAmount(periods);
    const totalFromGroups = groups
      .flatMap((g) => g.periods)
      .reduce((sum, p) => sum + p.amountCents, 0);
    expect(scheduleTotalCents(periods)).toBe(totalFromGroups);
  });
});

describe('labelForGroup', () => {
  it('labels the prorated first and last groups, and "Then" for the run between them', () => {
    const periods = buildThreeYearSchedule();
    const groups = groupScheduleByAmount(periods);

    expect(labelForGroup(0, groups.length, groups[0]!)).toBe('First period');
    expect(labelForGroup(1, groups.length, groups[1]!)).toBe('Then');
    expect(labelForGroup(2, groups.length, groups[2]!)).toBe('Final period');
  });

  it('gives a neutral label, never "Then", when the whole schedule is one group', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      calendar: 'gregorian',
      rentCents: 150000,
      billingDay: 1,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      ledgerStartDate: '2026-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
    };
    const periods = buildSchedule(terms, '2026-12-01');
    const groups = groupScheduleByAmount(periods);
    expect(groups).toHaveLength(1);

    expect(labelForGroup(0, 1, groups[0]!)).toBe('Rent');
  });

  it('gives a neutral label for a single-period lease, prorated or not', () => {
    const singleProrated: PlannedCharge = {
      generationKey: '2026-03-01',
      periodIndex: 0,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      occupiedStart: '2026-03-05',
      occupiedEnd: '2026-03-20',
      daysOccupied: 16,
      daysInPeriod: 31,
      dueDate: '2026-03-05',
      amountCents: 51613,
      isProrated: true,
    };
    expect(labelForGroup(0, 1, { periods: [singleProrated] })).toBe('Rent');
  });

  it('labels a middle group that is prorated but neither first nor last', () => {
    const middleProrated: PlannedCharge = {
      generationKey: '2026-02-01',
      periodIndex: 1,
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      occupiedStart: '2026-02-01',
      occupiedEnd: '2026-02-15',
      daysOccupied: 15,
      daysInPeriod: 28,
      dueDate: '2026-02-01',
      amountCents: 53571,
      isProrated: true,
    };
    expect(labelForGroup(1, 3, { periods: [middleProrated] })).toBe('Prorated period');
  });
});
