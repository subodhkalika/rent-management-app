import type { IsoDate } from './common.js';
import {
  type LeaseBillingTerms,
  type PlannedCharge,
  type MoveOutBillingPolicy,
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

/* ======================================================================== */
/* 2.1 Schedule fixtures                                                     */
/* ======================================================================== */

export const scheduleFixtures: readonly ScheduleFixture[] = [
  {
    // F1 — day 31 across a non-leap year. The February assertion is 2026-02-28.
    name: 'F1 day 31 across a non-leap year',
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 150000, billingDay: 31, startDate: '2026-01-01', endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 150000, billingDay: 31, startDate: '2028-01-01', endDate: null, ledgerStartDate: '2028-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-03-15', endDate: null, ledgerStartDate: '2026-03-15', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 20, startDate: '2026-03-15', endDate: null, ledgerStartDate: '2026-03-15', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-05-12', moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-05-12', moveOutBillingPolicy: 'stop_at_move_out' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-07-20', moveOutBillingPolicy: 'stop_at_move_out' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 5, startDate: '2026-01-01', endDate: '2026-06-10', ledgerStartDate: '2026-01-01', moveOutDate: '2026-07-20', moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-03-05', endDate: '2026-03-20', ledgerStartDate: '2026-03-05', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
    through: '2026-12-01',
    expected: [
      { generationKey: '2026-03-01', periodIndex: 0, periodStart: '2026-03-01', periodEnd: '2026-03-31', occupiedStart: '2026-03-05', occupiedEnd: '2026-03-20', daysOccupied: 16, daysInPeriod: 31, dueDate: '2026-03-05', amountCents: 51613, isProrated: true },
    ],
  },
  {
    // F6 — clean yearly, three entries, none prorated.
    name: 'F6 clean yearly',
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01', endDate: '2029-03-31', ledgerStartDate: '2026-04-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01', endDate: '2026-09-30', ledgerStartDate: '2026-04-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
    through: '2027-04-01',
    expected: [
      { generationKey: '2026-04-01', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2027-03-31', occupiedStart: '2026-04-01', occupiedEnd: '2026-09-30', daysOccupied: 183, daysInPeriod: 365, dueDate: '2026-04-01', amountCents: 1203288, isProrated: true },
    ],
  },
  {
    // F7b — yearly early move-out, stop_at_move_out.
    name: 'F7b yearly early move-out, stop_at_move_out',
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01', endDate: '2026-09-30', ledgerStartDate: '2026-04-01', moveOutDate: '2026-08-15', moveOutBillingPolicy: 'stop_at_move_out' },
    through: '2027-04-01',
    expected: [
      { generationKey: '2026-04-01', periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2027-03-31', occupiedStart: '2026-04-01', occupiedEnd: '2026-08-15', daysOccupied: 137, daysInPeriod: 365, dueDate: '2026-04-01', amountCents: 900822, isProrated: true },
    ],
  },
  {
    // F8 — yearly anchored on a leap day. Three entries, none prorated. No day is ever
    // uncovered or double-covered; year 0 ends Feb 27, every later year runs Feb 28 -> Feb 27.
    name: 'F8 yearly anchored on a leap day',
    terms: { frequency: 'yearly', calendar: 'gregorian', rentCents: 1200000, billingDay: 1, startDate: '2028-02-29', endDate: null, ledgerStartDate: '2028-02-29', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2025-06-15', endDate: null, ledgerStartDate: '2026-03-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 31, startDate: '2026-01-31', endDate: null, ledgerStartDate: '2026-01-31', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-01-01', endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: '2026-03-18', moveOutBillingPolicy: 'stop_at_move_out' },
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
    terms: { frequency: 'monthly', calendar: 'gregorian', rentCents: 100000, billingDay: 1, startDate: '2026-01-01', endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: '2026-03-18', moveOutBillingPolicy: 'bill_full_term' },
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
];

/* ======================================================================== */
/* 2.2 Generation fixtures (the lookahead rule)                              */
/* ======================================================================== */

const f1TermsForGeneration: LeaseBillingTerms = {
  frequency: 'monthly', calendar: 'gregorian', rentCents: 150000, billingDay: 31, startDate: '2026-01-01',
  endDate: null, ledgerStartDate: '2026-01-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term',
};

const f6TermsForGeneration: LeaseBillingTerms = {
  frequency: 'yearly', calendar: 'gregorian', rentCents: 2400000, billingDay: 1, startDate: '2026-04-01',
  endDate: '2029-03-31', ledgerStartDate: '2026-04-01', moveOutDate: null, moveOutBillingPolicy: 'bill_full_term',
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
