import { describe, it, expect } from 'vitest';
import { diffChargesAgainstSchedule, chargeOverdue, plannedChargeFromCharge, PLANNED_CHARGE_KEYS } from './charge.js';
import { chargeDriftFixtures, generationPlanFixtures } from './charge.fixtures.js';
import { scheduleFixtures } from './billing.fixtures.js';
import { chargesDueForGeneration, plannedCharge } from './billing.js';

describe('diffChargesAgainstSchedule', () => {
  for (const f of chargeDriftFixtures) {
    it(f.name, () => {
      expect(diffChargesAgainstSchedule({ charges: f.charges, planned: f.planned })).toEqual(f.expected);
    });
  }
});

describe('generationPlanFixtures', () => {
  /**
   * The property the whole phase rests on: generating at `through - LOOKAHEAD` must
   * reproduce the schedule fixture's own expectations, unedited. If this fails, the
   * generator and the preview are answering different questions.
   */
  for (const g of generationPlanFixtures) {
    it(`${g.name} — generating at the derived today reproduces the fixture exactly`, () => {
      const f = scheduleFixtures[g.scheduleFixtureIndex]!;
      expect(chargesDueForGeneration(f.terms, g.today)).toEqual(f.expected);
    });
  }
});

describe('the projection is total', () => {
  it('PLANNED_CHARGE_KEYS covers every field of PlannedCharge, with nothing extra', () => {
    const schemaKeys = Object.keys(plannedCharge.shape).sort();
    expect([...PLANNED_CHARGE_KEYS].sort()).toEqual(schemaKeys);
  });

  it('a stored row round-trips back to the PlannedCharge it was written from', () => {
    const f = scheduleFixtures[0]!;
    for (const p of f.expected) {
      const stored = {
        id: '01a10000-0000-7000-8000-00000000bbb1', leaseId: '01a10000-0000-7000-8000-00000000bbb2',
        type: 'rent' as const, currency: 'INR' as const, description: null, source: 'generated' as const,
        supersedesChargeId: null, voidedAt: null, voidedReason: null, createdByUserId: null,
        createdAt: '2026-04-01T09:00:00.000Z', ...p,
      };
      expect(plannedChargeFromCharge(stored)).toEqual(p);
    }
  });
});

describe('chargeOverdue', () => {
  it('is decided against the property-local today, and the due date itself is not late', () => {
    expect(chargeOverdue('2026-04-01', '2026-04-02')).toBe(true);
    expect(chargeOverdue('2026-04-01', '2026-04-01')).toBe(false);
    expect(chargeOverdue('2026-04-01', '2026-03-31')).toBe(false);
  });
});
