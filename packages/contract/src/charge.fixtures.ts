import type { Charge, ChargeDrift } from './charge.js';
import type { PlannedCharge } from './billing.js';
import { GENERATION_LOOKAHEAD_DAYS } from './billing.js';
import { addDays } from './calendar/civil-days.js';
import { scheduleFixtures } from './billing.fixtures.js';
import type { IsoDate } from './common.js';

/**
 * Shared worked examples for charge generation.
 *
 * The API's conformance test and the web app's preview tests both import these, so
 * the row the server writes and the line the browser draws are asserted against one
 * set of numbers rather than two that drift.
 */

/**
 * For each schedule fixture, the `today` that makes the generator produce exactly
 * that fixture's rows.
 *
 * `chargesDueForGeneration(terms, today)` is `buildSchedule(terms, generationHorizon(today))`,
 * and the horizon is `today + GENERATION_LOOKAHEAD_DAYS` — so running the generator at
 * `through - LOOKAHEAD` must reproduce the fixture's own `expected` array, unedited.
 * That is what makes this a real check rather than a restatement: the expectation
 * comes from a file the generator has no hand in.
 */
export interface GenerationPlanFixture {
  name: string;
  /** Index into `scheduleFixtures` — the terms and expectations live there. */
  scheduleFixtureIndex: number;
  /** Derived, never hand-written. */
  today: IsoDate;
  /** Generation keys the run must write, in order. */
  expectedRentKeys: string[];
}

export const generationPlanFixtures: readonly GenerationPlanFixture[] = scheduleFixtures.map(
  (f, i) => ({
    name: f.name,
    scheduleFixtureIndex: i,
    today: addDays(f.through, -GENERATION_LOOKAHEAD_DAYS),
    expectedRentKeys: f.expected
      .map((c) => c.generationKey)
      .filter((k): k is string => k !== null),
  }),
);

/* ---------- drift ---------- */

const planned = (over: Partial<PlannedCharge> & Pick<PlannedCharge, 'generationKey'>): PlannedCharge => ({
  periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2026-04-30',
  occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30',
  daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-01',
  amountCents: 100000, isProrated: false, ...over,
} as PlannedCharge);

const written = (over: Partial<Charge> & Pick<Charge, 'id' | 'generationKey'>): Charge => ({
  leaseId: '01a10000-0000-7000-8000-000000000001', type: 'rent',
  periodIndex: 0, periodStart: '2026-04-01', periodEnd: '2026-04-30',
  occupiedStart: '2026-04-01', occupiedEnd: '2026-04-30',
  daysOccupied: 30, daysInPeriod: 30, dueDate: '2026-04-01',
  amountCents: 100000, isProrated: false, currency: 'INR', description: null,
  source: 'generated', supersedesChargeId: null, voidedAt: null, voidedReason: null,
  createdByUserId: null, createdAt: '2026-04-01T09:00:00.000Z', ...over,
} as Charge);

export interface ChargeDriftFixture {
  name: string;
  charges: Charge[];
  planned: PlannedCharge[];
  expected: ChargeDrift[];
}

const ID1 = '01a10000-0000-7000-8000-00000000aaa1';
const ID2 = '01a10000-0000-7000-8000-00000000aaa2';

export const chargeDriftFixtures: readonly ChargeDriftFixture[] = [
  {
    name: 'D1 nothing drifted — the ordinary case, and the one that must stay silent',
    charges: [written({ id: ID1, generationKey: '2026-04-01' })],
    planned: [planned({ generationKey: '2026-04-01' })],
    expected: [],
  },
  {
    name: 'D2 amount — a rent step corrected after the period was already written',
    charges: [written({ id: ID1, generationKey: '2026-04-01', amountCents: 100000 })],
    planned: [planned({ generationKey: '2026-04-01', amountCents: 110000 })],
    expected: [{
      kind: 'amount', generationKey: '2026-04-01', chargeId: ID1,
      actual: { amountCents: 100000, dueDate: '2026-04-01' },
      expected: { amountCents: 110000, dueDate: '2026-04-01' },
    }],
  },
  {
    name: 'D3 due_date — billingDay changed after the row was written',
    charges: [written({ id: ID1, generationKey: '2026-04-01', dueDate: '2026-04-01' })],
    planned: [planned({ generationKey: '2026-04-01', dueDate: '2026-04-05' })],
    expected: [{
      kind: 'due_date', generationKey: '2026-04-01', chargeId: ID1,
      actual: { amountCents: 100000, dueDate: '2026-04-01' },
      expected: { amountCents: 100000, dueDate: '2026-04-05' },
    }],
  },
  {
    name: 'D4 missing — the schedule wants a period nothing covers yet',
    charges: [],
    planned: [planned({ generationKey: '2026-05-01', periodStart: '2026-05-01' })],
    expected: [{
      kind: 'missing', generationKey: '2026-05-01', chargeId: null, actual: null,
      expected: { amountCents: 100000, dueDate: '2026-04-01' },
    }],
  },
  {
    name: 'D5 unscheduled — the lookahead wrote past an end date set later',
    charges: [written({ id: ID2, generationKey: '2026-06-01' })],
    planned: [],
    expected: [{
      kind: 'unscheduled', generationKey: '2026-06-01', chargeId: ID2,
      actual: { amountCents: 100000, dueDate: '2026-04-01' }, expected: null,
    }],
  },
  {
    name: 'D6 one period reports once — a row wrong in both amount and date is one finding',
    charges: [written({ id: ID1, generationKey: '2026-04-01', amountCents: 100000, dueDate: '2026-04-01' })],
    planned: [planned({ generationKey: '2026-04-01', amountCents: 110000, dueDate: '2026-04-05' })],
    expected: [{
      kind: 'amount', generationKey: '2026-04-01', chargeId: ID1,
      actual: { amountCents: 100000, dueDate: '2026-04-01' },
      expected: { amountCents: 110000, dueDate: '2026-04-05' },
    }],
  },
  {
    name: 'D7 a manual charge is never drift — it has no generation key to compare',
    charges: [written({ id: ID1, generationKey: null, source: 'manual', type: 'late_fee' })],
    planned: [],
    expected: [],
  },
];
