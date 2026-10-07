import type { IsoDate } from './common.js';
import type { LeaseBillingTerms, PlannedCharge, RentEscalation } from './billing.js';
import type { ScheduleFixture, DueDateFixture, GeneratorFixture } from './billing.fixtures.js';

/**
 * Bikram Sambat worked examples — the BS counterpart of `billing.fixtures.ts`'s
 * Gregorian suite. Every figure here is computed, not illustrative: AD dates are
 * cross-checked directly against `bikram-sambat@^1` (see
 * `bs-data.conformance.test.ts` for the exhaustive version of that check; these
 * specific values were spot-verified the same way while writing this file). Day
 * counts and amounts are derived from those AD dates using the same arithmetic
 * `billing.test.ts` already trusts for the Gregorian fixtures.
 *
 * Covers what only BS exposes, per task 006b:
 * - a 32-day month (BSb1, Jestha 2000)
 * - billingDay 32 (BSb1/BSb2 — BS months reach day 32, impossible in Gregorian)
 * - a month-end clamp where the SAME calendar month has 29/30/31/32 days across
 *   different years (BSb-due3/BSb-due4: BS month 2, Jestha, is 32 days in 2000 but
 *   only 31 in 2001)
 * - a lease spanning Baisakh 1, the BS new year (mid-April), so a yearly BS lease is
 *   exercised across the year boundary (BSb3)
 */

const terms = (overrides: Partial<LeaseBillingTerms>): LeaseBillingTerms => ({
  frequency: 'monthly',
  rentCents: 100000,
  billingDay: 1,
  startDate: '2026-01-01',
  endDate: null,
  ledgerStartDate: '2026-01-01',
  moveOutDate: null,
  moveOutBillingPolicy: 'bill_full_term',
  calendar: 'bikram_sambat',
  rentSteps: [],
  ...overrides,
});

function charge(partial: Partial<PlannedCharge> & Pick<PlannedCharge, 'generationKey' | 'periodIndex'>): PlannedCharge {
  return {
    periodStart: partial.generationKey,
    periodEnd: partial.generationKey,
    occupiedStart: partial.generationKey,
    occupiedEnd: partial.generationKey,
    daysOccupied: 0,
    daysInPeriod: 0,
    dueDate: partial.generationKey,
    amountCents: 0,
    isProrated: false,
    ...partial,
  };
}

/* ======================================================================== */
/* BSb1 — monthly, billingDay 32, nine consecutive BS months of BS 2000:    */
/* Baisakh(30) Jestha(32) Ashadh(31) Shrawan(32) Bhadra(31) Ashwin(30)       */
/* Kartik(30) Mangsir(30) Poush(29) — exercises the full 29..32 range, and a */
/* billingDay that is structurally impossible in Gregorian, in one lease.   */
/* ======================================================================== */

export const bsScheduleFixtures: readonly ScheduleFixture[] = [
  {
    name: 'BSb1 billingDay 32 across nine BS months (29..32 day range), start BS2000-01-01',
    terms: terms({
      rentCents: 100000,
      billingDay: 32,
      startDate: '1943-04-14', // BS 2000-01-01 (Baisakh 1)
      ledgerStartDate: '1943-04-14',
    }),
    through: '1944-01-13', // BS 2000-09-29, Poush's last day — includes exactly periods 0..8
    expected: [
      charge({
        generationKey: '1943-04-14', // BS2000-01-01, Baisakh, 30 days
        periodIndex: 0,
        periodEnd: '1943-05-13',
        occupiedEnd: '1943-05-13',
        daysOccupied: 30,
        daysInPeriod: 30,
        dueDate: '1943-05-13', // billingDay 32 clamped to the month's 30th (last) day
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-05-14', // BS2000-02-01, Jestha, 32 days
        periodIndex: 1,
        periodEnd: '1943-06-14',
        occupiedEnd: '1943-06-14',
        daysOccupied: 32,
        daysInPeriod: 32,
        dueDate: '1943-06-14', // billingDay 32 is exact — Jestha has exactly 32 days
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-06-15', // BS2000-03-01, Ashadh, 31 days
        periodIndex: 2,
        periodEnd: '1943-07-15',
        occupiedEnd: '1943-07-15',
        daysOccupied: 31,
        daysInPeriod: 31,
        dueDate: '1943-07-15',
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-07-16', // BS2000-04-01, Shrawan, 32 days
        periodIndex: 3,
        periodEnd: '1943-08-16',
        occupiedEnd: '1943-08-16',
        daysOccupied: 32,
        daysInPeriod: 32,
        dueDate: '1943-08-16',
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-08-17', // BS2000-05-01, Bhadra, 31 days
        periodIndex: 4,
        periodEnd: '1943-09-16',
        occupiedEnd: '1943-09-16',
        daysOccupied: 31,
        daysInPeriod: 31,
        dueDate: '1943-09-16',
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-09-17', // BS2000-06-01, Ashwin, 30 days
        periodIndex: 5,
        periodEnd: '1943-10-16',
        occupiedEnd: '1943-10-16',
        daysOccupied: 30,
        daysInPeriod: 30,
        dueDate: '1943-10-16',
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-10-17', // BS2000-07-01, Kartik, 30 days
        periodIndex: 6,
        periodEnd: '1943-11-15',
        occupiedEnd: '1943-11-15',
        daysOccupied: 30,
        daysInPeriod: 30,
        dueDate: '1943-11-15',
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-11-16', // BS2000-08-01, Mangsir, 30 days
        periodIndex: 7,
        periodEnd: '1943-12-15',
        occupiedEnd: '1943-12-15',
        daysOccupied: 30,
        daysInPeriod: 30,
        dueDate: '1943-12-15',
        amountCents: 100000,
      }),
      charge({
        generationKey: '1943-12-16', // BS2000-09-01, Poush, 29 days
        periodIndex: 8,
        periodEnd: '1944-01-13',
        occupiedEnd: '1944-01-13',
        daysOccupied: 29,
        daysInPeriod: 29,
        dueDate: '1944-01-13',
        amountCents: 100000,
      }),
    ],
  },
];

/* ======================================================================== */
/* BSb — due-date fixtures                                                  */
/* ======================================================================== */

export const bsDueDateFixtures: readonly DueDateFixture[] = [
  {
    name: 'BS Jestha 2000 (32-day month) billingDay 32, exact — no Gregorian analogue',
    input: {
      frequency: 'monthly',
      period: { index: 0, start: '1943-05-14' as IsoDate, end: '1943-06-14' as IsoDate },
      occupiedStart: '1943-05-14',
      occupiedEnd: '1943-06-14',
      billingDay: 32,
      calendar: 'bikram_sambat',
    },
    expected: '1943-06-14',
  },
  {
    name: 'BS Jestha 2001 (31-day month) billingDay 32, clamped — SAME month index as above, one BS year later, a different length',
    input: {
      frequency: 'monthly',
      period: { index: 0, start: '1944-05-14' as IsoDate, end: '1944-06-13' as IsoDate },
      occupiedStart: '1944-05-14',
      occupiedEnd: '1944-06-13',
      billingDay: 32,
      calendar: 'bikram_sambat',
    },
    expected: '1944-06-13',
  },
  {
    name: 'BS Poush (29-day month) billingDay 32, clamped to the shortest BS month length',
    input: {
      frequency: 'monthly',
      period: { index: 0, start: '1943-12-16' as IsoDate, end: '1944-01-13' as IsoDate },
      occupiedStart: '1943-12-16',
      occupiedEnd: '1944-01-13',
      billingDay: 32,
      calendar: 'bikram_sambat',
    },
    expected: '1944-01-13',
  },
  {
    name: 'BS yearly ignores billingDay, same as Gregorian yearly',
    input: {
      frequency: 'yearly',
      period: { index: 0, start: '2025-09-26' as IsoDate, end: '2026-09-25' as IsoDate },
      occupiedStart: '2025-09-26',
      occupiedEnd: '2026-09-25',
      billingDay: 15,
      calendar: 'bikram_sambat',
    },
    expected: '2025-09-26',
  },
];

/* ======================================================================== */
/* BSb3 — yearly lease anchored off Baisakh 1 (BS2082-06-10, NOT the new     */
/* year), exercised across two Baisakh-1 crossings. BS2083-06 and BS2084-06 */
/* (Ashwin) are 31 and 30 days respectively, so the anniversary date stays  */
/* valid without clamping across both crossings.                           */
/* ======================================================================== */

export const bsYearlyFixture: ScheduleFixture = {
  name: 'BSb3 yearly BS lease spanning Baisakh 1 (the BS new year) twice',
  terms: terms({
    frequency: 'yearly',
    rentCents: 2400000,
    billingDay: 1, // ignored for yearly
    startDate: '2025-09-26', // BS2082-06-10 (Ashwin), well inside the BS year, not at Baisakh 1
    ledgerStartDate: '2025-09-26',
  }),
  through: '2027-09-25',
  expected: [
    charge({
      generationKey: '2025-09-26', // BS2082-06-10
      periodIndex: 0,
      periodEnd: '2026-09-25', // BS2083-06-09 — the period crosses BS2083's Baisakh 1 (2026-04-14) mid-period
      occupiedEnd: '2026-09-25',
      daysOccupied: 365,
      daysInPeriod: 365,
      dueDate: '2025-09-26',
      amountCents: 2400000,
    }),
    charge({
      generationKey: '2026-09-26', // BS2083-06-10
      periodIndex: 1,
      periodEnd: '2027-09-25', // BS2084-06-09 — crosses BS2084's Baisakh 1 (2027-04-14) mid-period
      occupiedEnd: '2027-09-25',
      daysOccupied: 365,
      daysInPeriod: 365,
      dueDate: '2026-09-26',
      amountCents: 2400000,
    }),
  ],
};

/* ======================================================================== */
/* BSb — rent escalation generator fixture (G6)                              */
/*                                                                            */
/* The Gregorian counterpart (G1..G5, G7, G8) lives in `billing.fixtures.ts`.*/
/* G6 belongs here, not there: it is the one generator fixture that exists   */
/* specifically to prove the BS calendar, so it is where someone looks first */
/* when a BS calendar change breaks something.                               */
/* ======================================================================== */

const tenPercentCompound: RentEscalation = { mode: 'percent', rateBps: 1000, intervalYears: 1, compounding: 'compound' };

export const bsGeneratorFixtures: readonly GeneratorFixture[] = [
  {
    // G6 — Bikram Sambat, monthly. Start is BS2000-01-15 (1943-04-28), mid-BS-month,
    // so each BS anniversary (BS2001-01-15, BS2002-01-15) is snapped forward to the
    // next BS month start (BS2001-02-01 = 1944-05-14, BS2002-02-01 = 1945-05-14) —
    // the same snap as G4, worked out in the BS calendar rather than the Gregorian
    // one, through the identical generic `firstPeriodStartOnOrAfter` path.
    name: 'G6 Bikram Sambat, monthly — the BS anniversary snaps too',
    input: {
      clause: tenPercentCompound,
      baseRentCents: 100000,
      startDate: '1943-04-28',
      endDate: '1945-12-31',
      frequency: 'monthly',
      calendar: 'bikram_sambat',
    },
    expected: [
      { effectiveFrom: '1944-05-14', rentCents: 110000, source: 'clause', clauseExpectedCents: 110000 },
      { effectiveFrom: '1945-05-14', rentCents: 121000, source: 'clause', clauseExpectedCents: 121000 },
    ],
  },
];
