import { describe, expect, it } from 'vitest';
import {
  generateRentSteps,
  recomputeLadderFrom,
  ladderFixtures,
  type RentEscalation,
  type DraftRentStep,
} from '@rms/contract';
import {
  percentToBps,
  bpsToPercent,
  toRentStepInput,
  currentRentCents,
  mergeDraftWithManualOverrides,
  escalationSummary,
  nextIncrease,
  hasTakenEffect,
  variancePercent,
} from './rent-ladder';

describe('percentToBps / bpsToPercent — the form-edge round trip', () => {
  it('rounds 7.35% to 735 bps, not the float-truncated 734 (load-bearing)', () => {
    // 7.35 * 100 === 734.9999999999999 in plain JS float math — this is the exact
    // bug `Math.round` at the form edge exists to prevent.
    expect(7.35 * 100).toBeCloseTo(734.9999999999999, 10);
    expect(percentToBps(7.35)).toBe(735);
  });

  it('round-trips a set of representative percentages', () => {
    for (const pct of [0.01, 1, 5, 7.35, 10, 12.5, 50]) {
      expect(bpsToPercent(percentToBps(pct))).toBeCloseTo(pct, 9);
    }
  });

  it('round-trips every bps value back to the same percent display', () => {
    for (const bps of [1, 100, 735, 1000, 5000]) {
      expect(percentToBps(bpsToPercent(bps))).toBe(bps);
    }
  });
});

describe('the 100%-instead-of-10% typo defence', () => {
  it('a rate of 100% drafts a first-row rent of ₹10,666.00 from a ₹5,333.00 base — visible immediately, not after a save', () => {
    // The user meant 10% (1000 bps) and typed "100" into a percent field that
    // converts via percentToBps — 100 * 100 = 10000 bps, the contract's own
    // MAX_ESCALATION_RATE_BPS ceiling is 5000 so this is clamped at the schema
    // boundary in real use, but the generator itself is total and never throws,
    // which is exactly why the live ladder — not a 422 — is the defence: the
    // landlord sees this number the moment the rate is entered.
    const clause: RentEscalation = { mode: 'percent', rateBps: percentToBps(100), intervalYears: 1, compounding: 'compound' };
    const steps = generateRentSteps({
      clause,
      baseRentCents: 533300,
      startDate: '2026-04-01',
      endDate: '2031-03-31',
      frequency: 'monthly',
      calendar: 'gregorian',
    });

    expect(clause.rateBps).toBe(10_000);
    expect(steps[0]?.rentCents).toBe(1_066_600); // ₹10,666.00
  });
});

describe('toRentStepInput', () => {
  it('strips drafting metadata down to the wire shape the API accepts', () => {
    const drafts: DraftRentStep[] = [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 530000, source: 'manual', clauseExpectedCents: 645300 },
    ];
    expect(toRentStepInput(drafts)).toEqual([
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause' },
      { effectiveFrom: '2028-04-01', rentCents: 530000, source: 'manual' },
    ]);
  });

  it('preserves a note when one is present', () => {
    const withNote = [{ effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause' as const, clauseExpectedCents: 586600, note: 'good tenant' }];
    expect(toRentStepInput(withNote)[0]).toMatchObject({ note: 'good tenant' });
  });
});

describe('currentRentCents', () => {
  it('returns the base rent when there are no steps (byte-identical, pre-escalation case)', () => {
    expect(currentRentCents(533300, [], '2026-06-01')).toBe(533300);
  });

  it('returns the rent in force at the given date — a pure lookup, never a recomputation', () => {
    const steps = [
      { effectiveFrom: '2027-04-01' as const, rentCents: 586600 },
      { effectiveFrom: '2028-04-01' as const, rentCents: 645300 },
    ];
    expect(currentRentCents(533300, steps, '2026-06-01')).toBe(533300);
    expect(currentRentCents(533300, steps, '2027-04-01')).toBe(586600);
    expect(currentRentCents(533300, steps, '2029-01-01')).toBe(645300);
  });

  it('is the exact mitigation for the in-flight onboarding trap: base ≠ today when steps exist', () => {
    // Onboarding a tenancy two years in: the landlord enters the rent AT START as
    // the base, and this is what tells them what today's rent actually is.
    const steps = [
      { effectiveFrom: '2024-04-01' as const, rentCents: 586600 },
      { effectiveFrom: '2025-04-01' as const, rentCents: 645300 },
      { effectiveFrom: '2026-04-01' as const, rentCents: 709800 },
    ];
    expect(currentRentCents(533300, steps, '2026-10-07')).toBe(709800);
  });
});

describe('mergeDraftWithManualOverrides', () => {
  it('keeps a manual step whose date matches a freshly generated one (editing the rate/base moves no dates)', () => {
    const previous: DraftRentStep[] = [
      { effectiveFrom: '2027-04-01', rentCents: 586600, source: 'clause', clauseExpectedCents: 586600 },
      { effectiveFrom: '2028-04-01', rentCents: 530000, source: 'manual', clauseExpectedCents: 645300 },
    ];
    const fresh: DraftRentStep[] = [
      { effectiveFrom: '2027-04-01', rentCents: 600000, source: 'clause', clauseExpectedCents: 600000 },
      { effectiveFrom: '2028-04-01', rentCents: 660000, source: 'clause', clauseExpectedCents: 660000 },
    ];
    expect(mergeDraftWithManualOverrides(fresh, previous)).toEqual([
      { effectiveFrom: '2027-04-01', rentCents: 600000, source: 'clause', clauseExpectedCents: 600000 },
      { effectiveFrom: '2028-04-01', rentCents: 530000, source: 'manual', clauseExpectedCents: 645300 },
    ]);
  });

  it('drops a manual step whose date no longer exists after an interval change', () => {
    const previous: DraftRentStep[] = [
      { effectiveFrom: '2027-04-01', rentCents: 530000, source: 'manual', clauseExpectedCents: 586600 },
    ];
    const fresh: DraftRentStep[] = [
      { effectiveFrom: '2028-04-01', rentCents: 645300, source: 'clause', clauseExpectedCents: 645300 },
    ];
    expect(mergeDraftWithManualOverrides(fresh, previous)).toEqual(fresh);
  });
});

describe('escalationSummary', () => {
  it('reads plainly when there is no clause', () => {
    expect(escalationSummary(null)).toBe('No scheduled rent increase');
  });

  it('states the rate, interval and compounding in landlord language', () => {
    expect(escalationSummary({ mode: 'percent', rateBps: 1000, intervalYears: 1, compounding: 'compound' })).toBe(
      '10% every year — compounds on the previous rent',
    );
    expect(escalationSummary({ mode: 'percent', rateBps: 1000, intervalYears: 2, compounding: 'simple' })).toBe(
      '10% every 2 years — always on the original rent',
    );
  });
});

describe('nextIncrease', () => {
  const steps = [
    { effectiveFrom: '2027-04-01' as const },
    { effectiveFrom: '2028-04-01' as const },
  ];
  it('finds the first step strictly after today', () => {
    expect(nextIncrease(steps, '2026-06-01')?.effectiveFrom).toBe('2027-04-01');
    expect(nextIncrease(steps, '2027-04-01')?.effectiveFrom).toBe('2028-04-01');
  });
  it('returns null when nothing is left', () => {
    expect(nextIncrease(steps, '2028-04-01')).toBeNull();
    expect(nextIncrease([], '2026-01-01')).toBeNull();
  });
});

describe('hasTakenEffect', () => {
  it('is true on or before today, false after', () => {
    expect(hasTakenEffect('2026-04-01', '2026-04-01')).toBe(true);
    expect(hasTakenEffect('2026-04-01', '2026-10-07')).toBe(true);
    expect(hasTakenEffect('2026-04-01', '2026-01-01')).toBe(false);
  });
});

describe('variancePercent — "a landlord cutting 6,453 to 5,300 should see 17.9%"', () => {
  it('matches the worked example from the escalation plan', () => {
    expect(variancePercent(645300, 530000)).toBeCloseTo(-17.89, 1);
  });
  it('is null when there is no clause to compare against, or nothing changed', () => {
    expect(variancePercent(null, 530000)).toBeNull();
    expect(variancePercent(530000, 530000)).toBeNull();
  });
});

describe('the cascade, bound to the contract fixtures (L1/L2)', () => {
  it('L1 — a manual override cascades through every later clause step', () => {
    const l1 = ladderFixtures.find((f) => f.name.startsWith('L1'))!;
    const result = recomputeLadderFrom({ clause: l1.clause, steps: l1.steps, index: l1.index, newRentCents: l1.newRentCents });
    expect(result).toEqual(l1.expected);
  });

  it('L2 — a step the landlord already set by hand survives the cascade untouched', () => {
    const l2 = ladderFixtures.find((f) => f.name.startsWith('L2'))!;
    const result = recomputeLadderFrom({ clause: l2.clause, steps: l2.steps, index: l2.index, newRentCents: l2.newRentCents });
    expect(result).toEqual(l2.expected);
    // The manual step's value is bitwise identical to its pre-cascade value — not
    // merely numerically equal by coincidence.
    const manualBefore = l2.steps.at(-1)!;
    const manualAfter = result.at(-1)!;
    expect(manualAfter.rentCents).toBe(manualBefore.rentCents);
    expect(manualAfter.source).toBe('manual');
  });
});
