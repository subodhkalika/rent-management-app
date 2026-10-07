import type { IsoDate } from './common.js';
import {
  type LeaseBillingTerms,
  type PlannedCharge,
  type MoveOutBillingPolicy,
  type RentEscalation,
  type DraftRentStep,
  type RentFrequency,
  type CalendarSystem,
  dueDateFor,
} from './billing.js';

/**
 * Worked examples, exported as data so the API's route tests and the web app's
 * preview tests assert IDENTICAL numbers. Every figure here is computed, not
 * illustrative — see `billing.test.ts` for the independent verification.
 */

export interface ScheduleFixture {
  name: string;
  terms: LeaseBillingTerms;
  through: IsoDate;
  expected: PlannedCharge[];
}

export interface DueDateFixture {
  name: string;
  input: Parameters<typeof dueDateFor>[0];
  expected: IsoDate;
}

export interface ProrationFixture {
  name: string;
  rentCents: number;
  daysOccupied: number;
  daysInPeriod: number;
  expected: number;
}

export interface GenerationFixture {
  name: string;
  terms: LeaseBillingTerms;
  today: IsoDate;
  expectedKeys: string[];
}

export interface BillingEndFixture {
  name: string;
  terms: LeaseBillingTerms;
  expected: IsoDate | null;
}

export interface GeneratorFixture {
  name: string;
  input: {
    clause: RentEscalation;
    baseRentCents: number;
    startDate: IsoDate;
    endDate: IsoDate | null;
    frequency: RentFrequency;
    calendar: CalendarSystem;
  };
  expected: DraftRentStep[];
}

export interface LadderFixture {
  name: string;
  clause: RentEscalation | null;
  steps: readonly DraftRentStep[];
  index: number;
  newRentCents: number;
  expected: DraftRentStep[];
}

/* ======================================================================== */
/* 2.1 Schedule fixtures                                                     */
/* ======================================================================== */

export const scheduleFixtures: readonly ScheduleFixture[] = [
  {
    // F1 — day 31 across a non-leap year. The February assertion is 2026-02-28.
    name: 'F1 day 31 across a non-leap year',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 150000, billingDay: 31, startDate: '2026-01-01', endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-31', amountCents: 150000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-28', amountCents: 150000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-31', amountCents: 150000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-30', amountCents: 150000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-31', amountCents: 150000, isProrated: false },
      { generationKey: '2026-06-01', periodIndex: 5, periodStart: '2026-06-01', periodEnd: '2026-06-30', occupiedStart: '2026-06-01', occupiedEnd: '2026-06-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-06-30', amountCents: 150000, isProrated: false },
      { generationKey: '2026-07-01', periodIndex: 6, periodStart: '2026-07-01', periodEnd: '2026-07-31', occupiedStart: '2026-07-01', occupiedEnd: '2026-07-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-07-31', amountCents: 150000, isProrated: false },
      { generationKey: '2026-08-01', periodIndex: 7, periodStart: '2026-08-01', periodEnd: '2026-08-31', occupiedStart: '2026-08-01', occupiedEnd: '2026-08-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-08-31', amountCents: 150000, isProrated: false },
      { generationKey: '2026-09-01', periodIndex: 8, periodStart: '2026-09-01', periodEnd: '2026-09-30', occupiedStart: '2026-09-01', occupiedEnd: '2026-09-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-09-30', amountCents: 150000, isProrated: false },
      { generationKey: '2026-10-01', periodIndex: 9, periodStart: '2026-10-01', periodEnd: '2026-10-31', occupiedStart: '2026-10-01', occupiedEnd: '2026-10-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-10-31', amountCents: 150000, isProrated: false },
      { generationKey: '2026-11-01', periodIndex: 10, periodStart: '2026-11-01', periodEnd: '2026-11-30', occupiedStart: '2026-11-01', occupiedEnd: '2026-11-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-11-30', amountCents: 150000, isProrated: false },
      { generationKey: '2026-12-01', periodIndex: 11, periodStart: '2026-12-01', periodEnd: '2026-12-31', occupiedStart: '2026-12-01', occupiedEnd: '2026-12-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-12-31', amountCents: 150000, isProrated: false },
    ],
  },
  {
    // F2 — day 31 across a leap year. February: daysInPeriod 29, due 2028-02-29.
    name: 'F2 day 31 across a leap year',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 150000, billingDay: 31, startDate: '2028-01-01', endDate: null, ledgerStartDate: '2028-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2028-12-01',
    expected: [
      { generationKey: '2028-01-01', periodIndex: 0, periodStart: '2028-01-01', periodEnd: '2028-01-31', occupiedStart: '2028-01-01', occupiedEnd: '2028-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2028-01-31', amountCents: 150000, isProrated: false },
      { generationKey: '2028-02-01', periodIndex: 1, periodStart: '2028-02-01', periodEnd: '2028-02-29', occupiedStart: '2028-02-01', occupiedEnd: '2028-02-29', daysOccupied: 29, daysInPeriod: 29, dueDate: '2028-02-29', amountCents: 150000, isProrated: false },
      { generationKey: '2028-03-01', periodIndex: 2, periodStart: '2028-03-01', periodEnd: '2028-03-31', occupiedStart: '2028-03-01', occupiedEnd: '2028-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2028-03-31', amountCents: 150000, isProrated: false },
      { generationKey: '2028-04-01', periodIndex: 3, periodStart: '2028-04-01', periodEnd: '2028-04-30', occupiedStart: '2028-04-01', occupiedEnd: '2028-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2028-04-30', amountCents: 150000, isProrated: false },
      { generationKey: '2028-05-01', periodIndex: 4, periodStart: '2028-05-01', periodEnd: '2028-05-31', occupiedStart: '2028-05-01', occupiedEnd: '2028-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2028-05-31', amountCents: 150000, isProrated: false },
      { generationKey: '2028-06-01', periodIndex: 5, periodStart: '2028-06-01', periodEnd: '2028-06-30', occupiedStart: '2028-06-01', occupiedEnd: '2028-06-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2028-06-30', amountCents: 150000, isProrated: false },
      { generationKey: '2028-07-01', periodIndex: 6, periodStart: '2028-07-01', periodEnd: '2028-07-31', occupiedStart: '2028-07-01', occupiedEnd: '2028-07-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2028-07-31', amountCents: 150000, isProrated: false },
      { generationKey: '2028-08-01', periodIndex: 7, periodStart: '2028-08-01', periodEnd: '2028-08-31', occupiedStart: '2028-08-01', occupiedEnd: '2028-08-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2028-08-31', amountCents: 150000, isProrated: false },
      { generationKey: '2028-09-01', periodIndex: 8, periodStart: '2028-09-01', periodEnd: '2028-09-30', occupiedStart: '2028-09-01', occupiedEnd: '2028-09-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2028-09-30', amountCents: 150000, isProrated: false },
      { generationKey: '2028-10-01', periodIndex: 9, periodStart: '2028-10-01', periodEnd: '2028-10-31', occupiedStart: '2028-10-01', occupiedEnd: '2028-10-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2028-10-31', amountCents: 150000, isProrated: false },
      { generationKey: '2028-11-01', periodIndex: 10, periodStart: '2028-11-01', periodEnd: '2028-11-30', occupiedStart: '2028-11-01', occupiedEnd: '2028-11-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2028-11-30', amountCents: 150000, isProrated: false },
      { generationKey: '2028-12-01', periodIndex: 11, periodStart: '2028-12-01', periodEnd: '2028-12-31', occupiedStart: '2028-12-01', occupiedEnd: '2028-12-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2028-12-31', amountCents: 150000, isProrated: false },
    ],
  },
  {
    // F3 — starting mid-period, billing day before move-in.
    name: 'F3 starting mid-period, billing day before move-in',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-03-15', endDate: null, ledgerStartDate: '2026-03-15', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-05-01',
    expected: [
      { generationKey: '2026-03-01', periodIndex: 0, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-15', occupiedEnd: '2026-03-31', daysOccupied: 17, daysInPeriod: 31, dueDate: '2026-03-15', amountCents: 54839, isProrated: true },
      { generationKey: '2026-04-01', periodIndex: 1, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 2, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-01', amountCents: 100000, isProrated: false },
    ],
  },
  {
    // F3b — starting mid-period, billing day inside the stub. [CORRECTION] to PLAN-V1 §4.3.
    name: 'F3b starting mid-period, billing day inside the stub',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 20, startDate: '2026-03-15', endDate: null, ledgerStartDate: '2026-03-15', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-05-01',
    expected: [
      { generationKey: '2026-03-01', periodIndex: 0, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-15', occupiedEnd: '2026-03-31', daysOccupied: 17, daysInPeriod: 31, dueDate: '2026-03-20', amountCents: 54839, isProrated: true },
      { generationKey: '2026-04-01', periodIndex: 1, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-20', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 2, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-20', amountCents: 100000, isProrated: false },
    ],
  },
  {
    // F4a — ends mid-period, bill_full_term. The original F4.
    name: 'F4a ends mid-period, bill_full_term',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-06-01', periodIndex: 5, periodStart: '2026-06-01', periodEnd: '2026-06-30', occupiedStart: '2026-06-01', occupiedEnd: '2026-06-10', daysOccupied: 10, daysInPeriod: 30, dueDate: '2026-06-05', amountCents: 33333, isProrated: true },
    ],
  },
  {
    // F4b — early move-out, bill_full_term. Byte-identical to F4a: proves the move-out is ignored.
    name: 'F4b early move-out, bill_full_term',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-05-12', moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-06-01', periodIndex: 5, periodStart: '2026-06-01', periodEnd: '2026-06-30', occupiedStart: '2026-06-01', occupiedEnd: '2026-06-10', daysOccupied: 10, daysInPeriod: 30, dueDate: '2026-06-05', amountCents: 33333, isProrated: true },
    ],
  },
  {
    // F4c — early move-out, stop_at_move_out. No June entry at all.
    name: 'F4c early move-out, stop_at_move_out',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-05-12', moveOutBillingPolicy: 'stop_at_move_out', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-12', daysOccupied: 12, daysInPeriod: 31, dueDate: '2026-05-05', amountCents: 38710, isProrated: true },
    ],
  },
  {
    // F4d — holdover, stop_at_move_out. The asymmetry fixture: the policy can only ever shorten.
    name: 'F4d holdover, stop_at_move_out',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-07-20', moveOutBillingPolicy: 'stop_at_move_out', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-06-01', periodIndex: 5, periodStart: '2026-06-01', periodEnd: '2026-06-30', occupiedStart: '2026-06-01', occupiedEnd: '2026-06-10', daysOccupied: 10, daysInPeriod: 30, dueDate: '2026-06-05', amountCents: 33333, isProrated: true },
    ],
  },
  {
    // F4e — holdover, bill_full_term. Completes the 2x2.
    name: 'F4e holdover, bill_full_term',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-07-20', moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-05', amountCents: 100000, isProrated: false },
      { generationKey: '2026-06-01', periodIndex: 5, periodStart: '2026-06-01', periodEnd: '2026-06-30', occupiedStart: '2026-06-01', occupiedEnd: '2026-06-10', daysOccupied: 10, daysInPeriod: 30, dueDate: '2026-06-05', amountCents: 33333, isProrated: true },
    ],
  },
  {
    // F5 — starts and ends inside the same period.
    name: 'F5 starts and ends inside the same period',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-03-05', endDate: '2026-03-20', ledgerStartDate: '2026-03-05', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-03-01', periodIndex: 0, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-05', occupiedEnd: '2026-03-20', daysOccupied: 16, daysInPeriod: 31, dueDate: '2026-03-05', amountCents: 51613, isProrated: true },
    ],
  },
  {
    // F6 — clean yearly, three entries, none prorated.
    name: 'F6 clean yearly',
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01', endDate: '2029-03-31', ledgerStartDate: '2026-04-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2029-04-01',
    expected: [
      { generationKey: '2026-04-01', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2027-03-31', occupiedStart: '2026-04-01', occupiedEnd: '2027-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2026-04-01', amountCents: 2400000, isProrated: false },
      { generationKey: '2027-04-01', periodIndex: 1, periodStart: '2027-04-01', periodEnd: '2028-03-31', occupiedStart: '2027-04-01', occupiedEnd: '2028-03-31', daysOccupied: 366, daysInPeriod: 366, dueDate: '2027-04-01', amountCents: 2400000, isProrated: false },
      { generationKey: '2028-04-01', periodIndex: 2, periodStart: '2028-04-01', periodEnd: '2029-03-31', occupiedStart: '2028-04-01', occupiedEnd: '2029-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2028-04-01', amountCents: 2400000, isProrated: false },
    ],
  },
  {
    // F7a — yearly terminated mid-year, bill_full_term. The original F7.
    name: 'F7a yearly terminated mid-year, bill_full_term',
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01', endDate: '2026-09-30', ledgerStartDate: '2026-04-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2027-04-01',
    expected: [
      { generationKey: '2026-04-01', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2027-03-31', occupiedStart: '2026-04-01', occupiedEnd: '2026-09-30', daysOccupied: 183, daysInPeriod: 365, dueDate: '2026-04-01', amountCents: 1203288, isProrated: true },
    ],
  },
  {
    // F7b — yearly early move-out, stop_at_move_out.
    name: 'F7b yearly early move-out, stop_at_move_out',
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01', endDate: '2026-09-30', ledgerStartDate: '2026-04-01', moveOutDate: '2026-08-15', moveOutBillingPolicy: 'stop_at_move_out', rentSteps: [] },
    through: '2027-04-01',
    expected: [
      { generationKey: '2026-04-01', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2027-03-31', occupiedStart: '2026-04-01', occupiedEnd: '2026-08-15', daysOccupied: 137, daysInPeriod: 365, dueDate: '2026-04-01', amountCents: 900822, isProrated: true },
    ],
  },
  {
    // F8 — yearly anchored on a leap day. Three entries, none prorated. No day is ever
    // uncovered or double-covered; year 0 ends Feb 27, every later year runs Feb 28 -> Feb 27.
    name: 'F8 yearly anchored on a leap day',
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 1200000, billingDay: 1, startDate: '2028-02-29', endDate: null, ledgerStartDate: '2028-02-29', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2031-01-01',
    expected: [
      { generationKey: '2028-02-29', periodIndex: 0, periodStart: '2028-02-29', periodEnd: '2029-02-27', occupiedStart: '2028-02-29', occupiedEnd: '2029-02-27', daysOccupied: 365, daysInPeriod: 365, dueDate: '2028-02-29', amountCents: 1200000, isProrated: false },
      { generationKey: '2029-02-28', periodIndex: 1, periodStart: '2029-02-28', periodEnd: '2030-02-27', occupiedStart: '2029-02-28', occupiedEnd: '2030-02-27', daysOccupied: 365, daysInPeriod: 365, dueDate: '2029-02-28', amountCents: 1200000, isProrated: false },
      { generationKey: '2030-02-28', periodIndex: 2, periodStart: '2030-02-28', periodEnd: '2031-02-27', occupiedStart: '2030-02-28', occupiedEnd: '2031-02-27', daysOccupied: 365, daysInPeriod: 365, dueDate: '2030-02-28', amountCents: 1200000, isProrated: false },
    ],
  },
  {
    // F9 — onboarding an in-flight tenancy. periodIndex 9, not 0 — pins I12.
    name: 'F9 onboarding an in-flight tenancy',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2025-06-15', endDate: null, ledgerStartDate: '2026-03-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-05-01',
    expected: [
      { generationKey: '2026-03-01', periodIndex: 9, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 10, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 11, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-01', amountCents: 100000, isProrated: false },
    ],
  },
  {
    // F10 — the composite case. One-day proration and the February clamp in one lease.
    name: 'F10 the composite case',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 31, startDate: '2026-01-31', endDate: null, ledgerStartDate: '2026-01-31', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-04-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-31', occupiedEnd: '2026-01-31', daysOccupied: 1, daysInPeriod: 31, dueDate: '2026-01-31', amountCents: 3226, isProrated: true },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-28', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-31', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-30', amountCents: 100000, isProrated: false },
    ],
  },
  {
    // F13 — rolling lease, move-out, stop_at_move_out. The policy is what terminates an
    // open-ended schedule — no April-onward entries despite the far `through`.
    name: 'F13 rolling lease, move-out, stop_at_move_out',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-01-01', endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: '2026-03-18', moveOutBillingPolicy: 'stop_at_move_out', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-18', daysOccupied: 18, daysInPeriod: 31, dueDate: '2026-03-01', amountCents: 58065, isProrated: true },
    ],
  },
  {
    // F14 — rolling lease, move-out, bill_full_term. THE TRAP, pinned deliberately: under
    // bill_full_term a rolling lease with a recorded move-out and no end_date keeps
    // billing forever. 12 full entries through December.
    name: 'F14 rolling lease, move-out, bill_full_term',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-01-01', endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: '2026-03-18', moveOutBillingPolicy: 'bill_full_term', rentSteps: [] },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-06-01', periodIndex: 5, periodStart: '2026-06-01', periodEnd: '2026-06-30', occupiedStart: '2026-06-01', occupiedEnd: '2026-06-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-06-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-07-01', periodIndex: 6, periodStart: '2026-07-01', periodEnd: '2026-07-31', occupiedStart: '2026-07-01', occupiedEnd: '2026-07-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-07-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-08-01', periodIndex: 7, periodStart: '2026-08-01', periodEnd: '2026-08-31', occupiedStart: '2026-08-01', occupiedEnd: '2026-08-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-08-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-09-01', periodIndex: 8, periodStart: '2026-09-01', periodEnd: '2026-09-30', occupiedStart: '2026-09-01', occupiedEnd: '2026-09-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-09-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-10-01', periodIndex: 9, periodStart: '2026-10-01', periodEnd: '2026-10-31', occupiedStart: '2026-10-01', occupiedEnd: '2026-10-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-10-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-11-01', periodIndex: 10, periodStart: '2026-11-01', periodEnd: '2026-11-30', occupiedStart: '2026-11-01', occupiedEnd: '2026-11-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-11-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-12-01', periodIndex: 11, periodStart: '2026-12-01', periodEnd: '2026-12-31', occupiedStart: '2026-12-01', occupiedEnd: '2026-12-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-12-01', amountCents: 100000, isProrated: false },
    ],
  },
  {
    // E10 — the override, end to end. L1's ladder (base + 10%/yr compound, index 1
    // overridden from 645300 to 530000, later clause steps cascade) applied over five
    // yearly periods. "The good relations case." Yearly cadence so each period lands
    // exactly on a ladder date, same anchor arithmetic F6/F8 already pin.
    name: 'E10 the override, L1\'s ladder end to end',
    terms: {
      frequency: 'yearly', calendar: 'gregorian', rentCents: 533300, billingDay: 1,
      startDate: '2026-04-01', endDate: '2031-03-31', ledgerStartDate: '2026-04-01',
      moveOutDate: null, moveOutBillingPolicy: 'bill_full_term',
      rentSteps: [
        { effectiveFrom: '2027-04-01', rentCents: 586600 },
        { effectiveFrom: '2028-04-01', rentCents: 530000 },
        { effectiveFrom: '2029-04-01', rentCents: 583000 },
        { effectiveFrom: '2030-04-01', rentCents: 641300 },
      ],
    },
    through: '2031-04-01',
    expected: [
      { generationKey: '2026-04-01', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2027-03-31', occupiedStart: '2026-04-01', occupiedEnd: '2027-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2026-04-01', amountCents: 533300, isProrated: false },
      { generationKey: '2027-04-01', periodIndex: 1, periodStart: '2027-04-01', periodEnd: '2028-03-31', occupiedStart: '2027-04-01', occupiedEnd: '2028-03-31', daysOccupied: 366, daysInPeriod: 366, dueDate: '2027-04-01', amountCents: 586600, isProrated: false },
      { generationKey: '2028-04-01', periodIndex: 2, periodStart: '2028-04-01', periodEnd: '2029-03-31', occupiedStart: '2028-04-01', occupiedEnd: '2029-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2028-04-01', amountCents: 530000, isProrated: false },
      { generationKey: '2029-04-01', periodIndex: 3, periodStart: '2029-04-01', periodEnd: '2030-03-31', occupiedStart: '2029-04-01', occupiedEnd: '2030-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2029-04-01', amountCents: 583000, isProrated: false },
      { generationKey: '2030-04-01', periodIndex: 4, periodStart: '2030-04-01', periodEnd: '2031-03-31', occupiedStart: '2030-04-01', occupiedEnd: '2031-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2030-04-01', amountCents: 641300, isProrated: false },
    ],
  },
  {
    // E11 — L2's ladder: the same override and cascade as E10, plus a sixth year
    // whose step was already `manual` at 800000 and survives the cascade untouched.
    name: 'E11 a manual step survives a cascade, L2\'s ladder end to end',
    terms: {
      frequency: 'yearly', calendar: 'gregorian', rentCents: 533300, billingDay: 1,
      startDate: '2026-04-01', endDate: '2032-03-31', ledgerStartDate: '2026-04-01',
      moveOutDate: null, moveOutBillingPolicy: 'bill_full_term',
      rentSteps: [
        { effectiveFrom: '2027-04-01', rentCents: 586600 },
        { effectiveFrom: '2028-04-01', rentCents: 530000 },
        { effectiveFrom: '2029-04-01', rentCents: 583000 },
        { effectiveFrom: '2030-04-01', rentCents: 641300 },
        { effectiveFrom: '2031-04-01', rentCents: 800000 },
      ],
    },
    through: '2032-04-01',
    expected: [
      { generationKey: '2026-04-01', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2027-03-31', occupiedStart: '2026-04-01', occupiedEnd: '2027-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2026-04-01', amountCents: 533300, isProrated: false },
      { generationKey: '2027-04-01', periodIndex: 1, periodStart: '2027-04-01', periodEnd: '2028-03-31', occupiedStart: '2027-04-01', occupiedEnd: '2028-03-31', daysOccupied: 366, daysInPeriod: 366, dueDate: '2027-04-01', amountCents: 586600, isProrated: false },
      { generationKey: '2028-04-01', periodIndex: 2, periodStart: '2028-04-01', periodEnd: '2029-03-31', occupiedStart: '2028-04-01', occupiedEnd: '2029-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2028-04-01', amountCents: 530000, isProrated: false },
      { generationKey: '2029-04-01', periodIndex: 3, periodStart: '2029-04-01', periodEnd: '2030-03-31', occupiedStart: '2029-04-01', occupiedEnd: '2030-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2029-04-01', amountCents: 583000, isProrated: false },
      { generationKey: '2030-04-01', periodIndex: 4, periodStart: '2030-04-01', periodEnd: '2031-03-31', occupiedStart: '2030-04-01', occupiedEnd: '2031-03-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2030-04-01', amountCents: 641300, isProrated: false },
      { generationKey: '2031-04-01', periodIndex: 5, periodStart: '2031-04-01', periodEnd: '2032-03-31', occupiedStart: '2031-04-01', occupiedEnd: '2032-03-31', daysOccupied: 366, daysInPeriod: 366, dueDate: '2031-04-01', amountCents: 800000, isProrated: false },
    ],
  },
  {
    // E12 — a decrease. Pins I16's removal: nothing in the engine enforces a
    // non-decreasing ladder, and this fixture exists so nobody reintroduces it.
    name: 'E12 a rent decrease, unremarked',
    terms: {
      frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1,
      startDate: '2026-01-01', endDate: null, ledgerStartDate: '2026-01-01',
      moveOutDate: null, moveOutBillingPolicy: 'bill_full_term',
      rentSteps: [{ effectiveFrom: '2026-04-01', rentCents: 80000 }],
    },
    through: '2026-05-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-01-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-01-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-02-01', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28', occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', daysOccupied: 28, daysInPeriod: 28, dueDate: '2026-02-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-03-01', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-01', occupiedEnd: '2026-03-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-03-01', amountCents: 100000, isProrated: false },
      { generationKey: '2026-04-01', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-30', occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-01', amountCents: 80000, isProrated: false },
      { generationKey: '2026-05-01', periodIndex: 4, periodStart: '2026-05-01', periodEnd: '2026-05-31', occupiedStart: '2026-05-01', occupiedEnd: '2026-05-31', daysOccupied: 31, daysInPeriod: 31, dueDate: '2026-05-01', amountCents: 80000, isProrated: false },
    ],
  },
  {
    // E13 — explicit ladder, no clause. Four hand-entered amounts, nothing generated.
    // Proves the engine never needs a clause to exist — the commercial case, free.
    name: 'E13 explicit ladder, no clause',
    terms: {
      frequency: 'yearly', calendar: 'gregorian', rentCents: 50000, billingDay: 1,
      startDate: '2026-01-01', endDate: '2030-12-31', ledgerStartDate: '2026-01-01',
      moveOutDate: null, moveOutBillingPolicy: 'bill_full_term',
      rentSteps: [
        { effectiveFrom: '2027-01-01', rentCents: 55000 },
        { effectiveFrom: '2028-01-01', rentCents: 60000 },
        { effectiveFrom: '2029-01-01', rentCents: 65000 },
        { effectiveFrom: '2030-01-01', rentCents: 70000 },
      ],
    },
    through: '2031-01-01',
    expected: [
      { generationKey: '2026-01-01', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-12-31', occupiedStart: '2026-01-01', occupiedEnd: '2026-12-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2026-01-01', amountCents: 50000, isProrated: false },
      { generationKey: '2027-01-01', periodIndex: 1, periodStart: '2027-01-01', periodEnd: '2027-12-31', occupiedStart: '2027-01-01', occupiedEnd: '2027-12-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2027-01-01', amountCents: 55000, isProrated: false },
      { generationKey: '2028-01-01', periodIndex: 2, periodStart: '2028-01-01', periodEnd: '2028-12-31', occupiedStart: '2028-01-01', occupiedEnd: '2028-12-31', daysOccupied: 366, daysInPeriod: 366, dueDate: '2028-01-01', amountCents: 60000, isProrated: false },
      { generationKey: '2029-01-01', periodIndex: 3, periodStart: '2029-01-01', periodEnd: '2029-12-31', occupiedStart: '2029-01-01', occupiedEnd: '2029-12-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2029-01-01', amountCents: 65000, isProrated: false },
      { generationKey: '2030-01-01', periodIndex: 4, periodStart: '2030-01-01', periodEnd: '2030-12-31', occupiedStart: '2030-01-01', occupiedEnd: '2030-12-31', daysOccupied: 365, daysInPeriod: 365, dueDate: '2030-01-01', amountCents: 70000, isProrated: false },
    ],
  },
];

/* ======================================================================== */
/* 2.2 Generation fixtures (the lookahead rule)                              */
/* ======================================================================== */

const f1TermsForGeneration: LeaseBillingTerms = {
  frequency: 'monthly', calendar: 'gregorian', rentCents: 150000, billingDay: 31, startDate: '2026-01-01',
  endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [],
};

const f6TermsForGeneration: LeaseBillingTerms = {
  frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01',
  endDate: '2029-03-31', ledgerStartDate: '2026-04-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term', rentSteps: [],
};

export const generationFixtures: readonly GenerationFixture[] = [
  // F11 — monthly, terms of F1.
  { name: 'F11 monthly today=2026-02-28', terms: f1TermsForGeneration, today: '2026-02-28', expectedKeys: ['2026-01-01', '2026-02-01', '2026-03-01'] },
  { name: 'F11 monthly today=2026-03-01', terms: f1TermsForGeneration, today: '2026-03-01', expectedKeys: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'] },
  { name: 'F11 monthly today=2026-03-20', terms: f1TermsForGeneration, today: '2026-03-20', expectedKeys: ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'] },
  // F12 — yearly, terms of F6.
  { name: 'F12 yearly today=2027-02-05', terms: f6TermsForGeneration, today: '2027-02-05', expectedKeys: ['2026-04-01'] },
  { name: 'F12 yearly today=2027-03-05', terms: f6TermsForGeneration, today: '2027-03-05', expectedKeys: ['2026-04-01', '2027-04-01'] },
];

/* ======================================================================== */
/* 2.3 Due-date fixtures                                                     */
/* ======================================================================== */

export const dueDateFixtures: readonly DueDateFixture[] = [
  {
    name: 'monthly Feb 2026 billingDay 31 full',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2026-02-01', end: '2026-02-28' }, occupiedStart: '2026-02-01', occupiedEnd: '2026-02-28', billingDay: 31 },
    expected: '2026-02-28',
  },
  {
    name: 'monthly Feb 2028 billingDay 31 full (leap)',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2028-02-01', end: '2028-02-29' }, occupiedStart: '2028-02-01', occupiedEnd: '2028-02-29', billingDay: 31 },
    expected: '2028-02-29',
  },
  {
    name: 'monthly Feb 2100 billingDay 31 full (century non-leap)',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2100-02-01', end: '2100-02-28' }, occupiedStart: '2100-02-01', occupiedEnd: '2100-02-28', billingDay: 31 },
    expected: '2100-02-28',
  },
  {
    name: 'monthly Feb 2000 billingDay 29 full (century leap)',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2000-02-01', end: '2000-02-29' }, occupiedStart: '2000-02-01', occupiedEnd: '2000-02-29', billingDay: 29 },
    expected: '2000-02-29',
  },
  {
    name: 'monthly Apr 2026 billingDay 31 full',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2026-04-01', end: '2026-04-30' }, occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30', billingDay: 31 },
    expected: '2026-04-30',
  },
  {
    name: 'monthly Mar 2026 billingDay 1, occupied 03-15..03-31 (floored)',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2026-03-01', end: '2026-03-31' }, occupiedStart: '2026-03-15', occupiedEnd: '2026-03-31', billingDay: 1 },
    expected: '2026-03-15',
  },
  {
    name: 'monthly Mar 2026 billingDay 20, occupied 03-15..03-31 (honoured)',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2026-03-01', end: '2026-03-31' }, occupiedStart: '2026-03-15', occupiedEnd: '2026-03-31', billingDay: 20 },
    expected: '2026-03-20',
  },
  {
    name: 'monthly Jun 2026 billingDay 25, occupied 06-01..06-10 (ceilinged)',
    input: { frequency: 'monthly', calendar: 'gregorian', period: { index: 0, start: '2026-06-01', end: '2026-06-30' }, occupiedStart: '2026-06-01', occupiedEnd: '2026-06-10', billingDay: 25 },
    expected: '2026-06-10',
  },
  {
    name: 'yearly 2026-04-01.. billingDay 15 full (ignored)',
    input: { frequency: 'yearly', calendar: 'gregorian', period: { index: 0, start: '2026-04-01', end: '2027-03-31' }, occupiedStart: '2026-04-01', occupiedEnd: '2027-03-31', billingDay: 15 },
    expected: '2026-04-01',
  },
];

/* ======================================================================== */
/* 2.4 Proration fixtures                                                    */
/* ======================================================================== */

export const prorationFixtures: readonly ProrationFixture[] = [
  { name: 'F3', rentCents: 100000, daysOccupied: 17, daysInPeriod: 31, expected: 54839 },
  { name: 'F4', rentCents: 100000, daysOccupied: 10, daysInPeriod: 30, expected: 33333 },
  { name: 'F5', rentCents: 100000, daysOccupied: 16, daysInPeriod: 31, expected: 51613 },
  { name: 'F10', rentCents: 100000, daysOccupied: 1, daysInPeriod: 31, expected: 3226 },
  { name: 'F7, yearly', rentCents: 2400000, daysOccupied: 183, daysInPeriod: 365, expected: 1203288 },
  { name: 'leap lease year, exactly half', rentCents: 2400000, daysOccupied: 183, daysInPeriod: 366, expected: 1200000 },
  { name: 'identity on a full period', rentCents: 100000, daysOccupied: 31, daysInPeriod: 31, expected: 100000 },
  { name: 'identity, leap February', rentCents: 100000, daysOccupied: 29, daysInPeriod: 29, expected: 100000 },
  { name: 'pins Math.round half-up', rentCents: 100001, daysOccupied: 15, daysInPeriod: 30, expected: 50001 },
  { name: 'zero-day span', rentCents: 100000, daysOccupied: 0, daysInPeriod: 31, expected: 0 },
];

/* ======================================================================== */
/* Amendment A §4 — effectiveBillingEnd fixtures                             */
/* ======================================================================== */

function billingEndTerms(
  endDate: IsoDate | null,
  moveOutDate: IsoDate | null,
  policy: MoveOutBillingPolicy,
): LeaseBillingTerms {
  return {
    frequency: 'monthly', calendar: 'gregorian',
    rentCents: 100000,
    billingDay: 1,
    startDate: '2026-01-01',
    endDate,
    ledgerStartDate: '2026-01-01',
    moveOutDate,
    moveOutBillingPolicy: policy,
    rentSteps: [],
  };
}

export const billingEndFixtures: readonly BillingEndFixture[] = [
  { name: 'end set, no move-out, bill_full_term', terms: billingEndTerms('2026-06-10', null, 'bill_full_term'), expected: '2026-06-10' },
  { name: 'end set, no move-out, stop_at_move_out', terms: billingEndTerms('2026-06-10', null, 'stop_at_move_out'), expected: '2026-06-10' },
  { name: 'early move-out, bill_full_term (ignored)', terms: billingEndTerms('2026-06-10', '2026-05-12', 'bill_full_term'), expected: '2026-06-10' },
  { name: 'early move-out, stop_at_move_out (shortens)', terms: billingEndTerms('2026-06-10', '2026-05-12', 'stop_at_move_out'), expected: '2026-05-12' },
  { name: 'holdover, bill_full_term', terms: billingEndTerms('2026-06-10', '2026-07-20', 'bill_full_term'), expected: '2026-06-10' },
  { name: 'holdover, stop_at_move_out (shorten only, never extend)', terms: billingEndTerms('2026-06-10', '2026-07-20', 'stop_at_move_out'), expected: '2026-06-10' },
  { name: 'same-day move-out, stop_at_move_out (no off-by-one)', terms: billingEndTerms('2026-06-10', '2026-06-10', 'stop_at_move_out'), expected: '2026-06-10' },
  { name: 'rolling lease, no move-out, bill_full_term', terms: billingEndTerms(null, null, 'bill_full_term'), expected: null },
  { name: 'rolling lease, no move-out, stop_at_move_out', terms: billingEndTerms(null, null, 'stop_at_move_out'), expected: null },
  { name: 'rolling lease, move-out, bill_full_term (the F14 trap)', terms: billingEndTerms(null, '2026-03-18', 'bill_full_term'), expected: null },
  { name: 'rolling lease, move-out, stop_at_move_out', terms: billingEndTerms(null, '2026-03-18', 'stop_at_move_out'), expected: '2026-03-18' },
];

/* ======================================================================== */
/* Rent escalation — generator fixtures (G1..G5, G7, G8 — G6 is Bikram       */
/* Sambat and lives in `billing.bs.fixtures.ts`, where a BS calendar change  */
/* is actually looked for)                                                   */
/*                                                                            */
/* Every ladder below was hand-verified against the documented formula       */
/* (`proposeOnce`/`clauseExpectedRent` in billing.ts) before being committed  */
/* — see the task report for the working. G8 is the one exception: hand-     */
/* checking thirty compound steps is exactly the kind of arithmetic a        */
/* reviewer cannot usefully eyeball either, so its ladder is built below by   */
/* `independentCompoundLadder`, a standalone reimplementation of the SAME    */
/* documented formula. It is kept deliberately separate from `billing.ts`'s  */
/* own `proposeOnce` on purpose, so this fixture still catches a             */
/* threading/off-by-one bug in the real generator instead of echoing it —    */
/* DO NOT refactor it to call `proposeOnce` (or import it), even to remove   */
/* the duplication: a fixture that calls the function it is meant to check   */
/* is a hollow test that always passes.                                     */
/* ======================================================================== */

const tenPercentCompound: RentEscalation = { mode: 'percent', rateBps: 1000, intervalYears: 1, compounding: 'compound' };
const tenPercentSimple: RentEscalation = { mode: 'percent', rateBps: 1000, intervalYears: 1, compounding: 'simple' };
const tenPercentEvery2Years: RentEscalation = { mode: 'percent', rateBps: 1000, intervalYears: 2, compounding: 'compound' };

/**
 * DELIBERATELY REIMPLEMENTS `billing.ts`'s `proposeOnce` formula, on purpose, as a
 * fully independent copy. This is the ONLY arithmetic in this fixtures file, built
 * solely so G8's 30-step ladder does not have to be hand-typed (hand-checking thirty
 * compound steps is exactly where a transcription error hides).
 *
 * DO NOT import `proposeOnce` from `billing.ts` here, and do not "deduplicate" this
 * against it. A fixture that calls the function it exists to check always passes —
 * it stops being a fixture and becomes a mirror. This copy must keep diverging
 * accidentally from the real one being the whole point: if someone breaks the
 * threading or the rounding in `generateRentSteps`, this independent copy is what
 * still catches it.
 */
function independentProposeOnce(cents: number, rateBps: number): number {
  const raw = (cents * (10_000 + rateBps)) / 10_000;
  return Math.round(raw / 100) * 100;
}

/** Builds G8's 30-step compound ladder via `independentProposeOnce` above — see that
 *  function's docstring for why this is not simply `generateRentSteps(...)`. */
function independentCompoundLadder(baseRentCents: number, rateBps: number, cycles: number): number[] {
  const out: number[] = [];
  let rent = baseRentCents;
  for (let i = 0; i < cycles; i += 1) {
    rent = independentProposeOnce(rent, rateBps);
    out.push(rent);
  }
  return out;
}

export const generatorFixtures: readonly GeneratorFixture[] = [
  {
    // G1 — the requirement itself: 10%/yr compound from ₹5,333.00, five years,
    // monthly billing. The user's own figures, as four editable rows.
    name: 'G1 10%/yr compound, five-year monthly lease',
    input: {
      clause: tenPercentCompound,
      baseRentCents: 533300,
      startDate: '2026-04-01',
      endDate: '2031-03-31',
      frequency: 'monthly',
      calendar: 'gregorian',
    },
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 645300, source: 'clause', clauseExpectedCents: 645300 },
      { effectiveFrom: '2029-04-01', rentCents: 709800, source: 'clause', clauseExpectedCents: 709800 },
      { effectiveFrom: '2030-04-01', rentCents: 780800, source: 'clause', clauseExpectedCents: 780800 },
    ],
  },
  {
    // G2 — the same clause, `simple`: every cycle applies 10% to the ORIGINAL base,
    // not to the previous step.
    name: 'G2 10%/yr simple, same base',
    input: {
      clause: tenPercentSimple,
      baseRentCents: 533300,
      startDate: '2026-04-01',
      endDate: '2031-03-31',
      frequency: 'monthly',
      calendar: 'gregorian',
    },
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 640000, source: 'clause', clauseExpectedCents: 640000 },
      { effectiveFrom: '2029-04-01', rentCents: 693300, source: 'clause', clauseExpectedCents: 693300 },
      { effectiveFrom: '2030-04-01', rentCents: 746600, source: 'clause', clauseExpectedCents: 746600 },
    ],
  },
  {
    // G2b — G2 extended one more cycle: 533300 * 1.5 = 799950 -> 7999.5 -> 8000,
    // pinning half-up rounding exactly at the `.5` boundary (banker's rounding would
    // give 799900 instead).
    name: 'G2b 10%/yr simple, one cycle further — pins half-up at the .5 boundary',
    input: {
      clause: tenPercentSimple,
      baseRentCents: 533300,
      startDate: '2026-04-01',
      endDate: '2032-03-31',
      frequency: 'monthly',
      calendar: 'gregorian',
    },
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 640000, source: 'clause', clauseExpectedCents: 640000 },
      { effectiveFrom: '2029-04-01', rentCents: 693300, source: 'clause', clauseExpectedCents: 693300 },
      { effectiveFrom: '2030-04-01', rentCents: 746600, source: 'clause', clauseExpectedCents: 746600 },
      { effectiveFrom: '2031-04-01', rentCents: 800000, source: 'clause', clauseExpectedCents: 800000 },
    ],
  },
  {
    // G3 — a non-round base. The base is untouched (533350 stays 533350); only the
    // DRAFTED step rounds, to 586700.
    name: 'G3 non-round base is never rewritten',
    input: {
      clause: tenPercentCompound,
      baseRentCents: 533350,
      startDate: '2026-04-01',
      endDate: '2028-03-31',
      frequency: 'monthly',
      calendar: 'gregorian',
    },
    expected: [{ effectiveFrom: '2027-04-01', rentCents: 586700, source: 'clause', clauseExpectedCents: 586700 }],
  },
  {
    // G4 — a mid-month start. The raw anniversary (2027-03-15) is snapped forward to
    // the next period start (2027-04-01), never to the un-snapped date itself.
    name: 'G4 mid-month start snaps the anniversary forward to a period start',
    input: {
      clause: tenPercentCompound,
      baseRentCents: 533300,
      startDate: '2026-03-15',
      endDate: '2028-12-31',
      frequency: 'monthly',
      calendar: 'gregorian',
    },
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 645300, source: 'clause', clauseExpectedCents: 645300 },
    ],
  },
  {
    // G5 — every TWO years, yearly billing. Both anchors are the same `addYears` from
    // the same `startDate`, so every step already lands on a period start — no
    // snapping needed, unlike G4.
    name: 'G5 10% every 2 years, yearly billing — no snap needed',
    input: {
      clause: tenPercentEvery2Years,
      baseRentCents: 533300,
      startDate: '2026-04-01',
      endDate: '2031-03-31',
      frequency: 'yearly',
      calendar: 'gregorian',
    },
    expected: [
      { effectiveFrom: '2028-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2030-04-01', rentCents: 645300, source: 'clause', clauseExpectedCents: 645300 },
    ],
  },
  {
    // G7 — a leap-day start, yearly. `addYears` clamps Feb 29 to Feb 28 in a
    // non-leap target year — the same clamp F8's periods already exercise — and
    // because the cadence is yearly the clamped date is automatically a period
    // start, so (like G5) nothing needs snapping on top of the clamp.
    name: 'G7 leap-day start, yearly — the F8 clamp, now in the generator',
    input: {
      clause: tenPercentCompound,
      baseRentCents: 1200000,
      startDate: '2028-02-29',
      endDate: '2031-02-27',
      frequency: 'yearly',
      calendar: 'gregorian',
    },
    expected: [
      { effectiveFrom: '2029-02-28', rentCents: 1320000, source: 'clause', clauseExpectedCents: 1320000 },
      { effectiveFrom: '2030-02-28', rentCents: 1452000, source: 'clause', clauseExpectedCents: 1452000 },
    ],
  },
  {
    // G8 — a rolling lease (`endDate: null`) has no natural stopping point. The
    // generator caps at MAX_GENERATED_STEPS (30) — exactly 30 steps, never more.
    name: 'G8 rolling lease — capped at MAX_GENERATED_STEPS, never more',
    input: {
      clause: tenPercentCompound,
      baseRentCents: 100000,
      startDate: '2026-01-01',
      endDate: null,
      frequency: 'monthly',
      calendar: 'gregorian',
    },
    expected: independentCompoundLadder(100000, 1000, 30).map(
      (rentCents, i): DraftRentStep => ({
        effectiveFrom: `${2027 + i}-01-01` as IsoDate,
        rentCents,
        source: 'clause',
        clauseExpectedCents: rentCents,
      }),
    ),
  },
];

/* ======================================================================== */
/* Rent escalation — ladder-recompute fixtures (L1..L3)                      */
/* ======================================================================== */

const l1l2Steps: readonly DraftRentStep[] = [
  { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
  { effectiveFrom: '2028-04-01', rentCents: 645300, source: 'clause', clauseExpectedCents: 645300 },
  { effectiveFrom: '2029-04-01', rentCents: 709800, source: 'clause', clauseExpectedCents: 709800 },
  { effectiveFrom: '2030-04-01', rentCents: 780800, source: 'clause', clauseExpectedCents: 780800 },
];

// G2's simple-mode ladder, all `clause` — the starting point for L4/L5 below.
const simpleLadderSteps: readonly DraftRentStep[] = [
  { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
  { effectiveFrom: '2028-04-01', rentCents: 640000, source: 'clause', clauseExpectedCents: 640000 },
  { effectiveFrom: '2029-04-01', rentCents: 693300, source: 'clause', clauseExpectedCents: 693300 },
  { effectiveFrom: '2030-04-01', rentCents: 746600, source: 'clause', clauseExpectedCents: 746600 },
];

export const ladderFixtures: readonly LadderFixture[] = [
  {
    // L1 — G1's ladder, override index 1 (2028-04-01, agreed 645300) down to 530000:
    // "good relations" instead of the full 10%. Every later step was `clause`, so
    // every later step recomputes from the override.
    name: "L1 override cascades through every later clause step (the 'good relations' case)",
    clause: tenPercentCompound,
    steps: l1l2Steps,
    index: 1,
    newRentCents: 530000,
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 530000, source: 'manual', clauseExpectedCents: 645300 },
      { effectiveFrom: '2029-04-01', rentCents: 583000, source: 'clause', clauseExpectedCents: 583000 },
      { effectiveFrom: '2030-04-01', rentCents: 641300, source: 'clause', clauseExpectedCents: 641300 },
    ],
  },
  {
    // L2 — identical override, but the final step was already `manual` at 800000
    // before the override. Decision 5: a manual step is never recomputed.
    name: 'L2 the same override never touches a step the landlord already set by hand',
    clause: tenPercentCompound,
    steps: [
      ...l1l2Steps,
      { effectiveFrom: '2031-04-01', rentCents: 800000, source: 'manual', clauseExpectedCents: 858900 },
    ],
    index: 1,
    newRentCents: 530000,
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 530000, source: 'manual', clauseExpectedCents: 645300 },
      { effectiveFrom: '2029-04-01', rentCents: 583000, source: 'clause', clauseExpectedCents: 583000 },
      { effectiveFrom: '2030-04-01', rentCents: 641300, source: 'clause', clauseExpectedCents: 641300 },
      { effectiveFrom: '2031-04-01', rentCents: 800000, source: 'manual', clauseExpectedCents: 858900 },
    ],
  },
  {
    // L3 — the commercial case: no clause at all, so nothing cascades. Only the
    // touched index changes.
    name: 'L3 clause: null — an override changes only the touched step, nothing cascades',
    clause: null,
    steps: [
      { effectiveFrom: '2027-01-01', rentCents: 55000, source: 'manual', clauseExpectedCents: null },
      { effectiveFrom: '2028-01-01', rentCents: 60000, source: 'manual', clauseExpectedCents: null },
      { effectiveFrom: '2029-01-01', rentCents: 65000, source: 'manual', clauseExpectedCents: null },
    ],
    index: 1,
    newRentCents: 58000,
    expected: [
      { effectiveFrom: '2027-01-01', rentCents: 55000, source: 'manual', clauseExpectedCents: null },
      { effectiveFrom: '2028-01-01', rentCents: 58000, source: 'manual', clauseExpectedCents: null },
      { effectiveFrom: '2029-01-01', rentCents: 65000, source: 'manual', clauseExpectedCents: null },
    ],
  },
  {
    // L4 — the re-anchoring decision, pinned: a `simple` clause overridden mid-ladder
    // does NOT start compounding. Override index 1 (2028-04-01, agreed 640000) down
    // to 600000. If this cascaded like `compound` (folding onto the previous step),
    // index 2 would be 660000 and index 3 would be 726000 — WRONG for `simple`. The
    // correct, re-anchored answer treats 600000 as the new base and applies "j
    // cycles of 10% simple" from there: 600000*(1+1*10%)=660000 (same as the wrong
    // answer by coincidence, one cycle out), 600000*(1+2*10%)=720000 — which is where
    // this fixture actually distinguishes the two theories.
    name: 'L4 simple-mode override re-anchors — it does not switch the clause to compounding',
    clause: tenPercentSimple,
    steps: simpleLadderSteps,
    index: 1,
    newRentCents: 600000,
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 600000, source: 'manual', clauseExpectedCents: 640000 },
      { effectiveFrom: '2029-04-01', rentCents: 660000, source: 'clause', clauseExpectedCents: 660000 },
      { effectiveFrom: '2030-04-01', rentCents: 720000, source: 'clause', clauseExpectedCents: 720000 },
    ],
  },
  {
    // L5 — the subtler half of re-anchoring: the elapsed-cycle counter advances
    // through a `manual` step that is skipped (not recomputed), because a cycle is a
    // unit of time under the clause, not a property of which steps got recomputed.
    // Override index 0 (2027-04-01) to 600000; index 1 is ALREADY `manual` at an
    // unrelated figure and is preserved untouched; index 2 is still one cycle later
    // than index 1 was, i.e. TWO cycles after the override (600000 * 1.2 = 720000),
    // not one (which would wrongly give 660000 if the skipped manual step did not
    // count).
    name: 'L5 simple mode counts elapsed cycles through a skipped manual step',
    clause: tenPercentSimple,
    steps: [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 650000, source: 'manual', clauseExpectedCents: 640000 },
      { effectiveFrom: '2029-04-01', rentCents: 693300, source: 'clause', clauseExpectedCents: 693300 },
      { effectiveFrom: '2030-04-01', rentCents: 746600, source: 'clause', clauseExpectedCents: 746600 },
    ],
    index: 0,
    newRentCents: 600000,
    expected: [
      { effectiveFrom: '2027-04-01', rentCents: 600000, source: 'manual', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 650000, source: 'manual', clauseExpectedCents: 640000 },
      { effectiveFrom: '2029-04-01', rentCents: 720000, source: 'clause', clauseExpectedCents: 720000 },
      { effectiveFrom: '2030-04-01', rentCents: 780000, source: 'clause', clauseExpectedCents: 780000 },
    ],
  },
];
