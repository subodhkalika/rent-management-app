import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, GENERATION_LOOKAHEAD_DAYS, scheduleFixtures, type LeaseDetail } from '@rms/contract';
import { previewActivationCharges } from './generation-preview';

const now = '2026-01-01T00:00:00.000Z';

function leaseDetailFromFixture(overrides: Partial<LeaseDetail> = {}): LeaseDetail {
  const f = scheduleFixtures.find((x) => x.name === 'F9 onboarding an in-flight tenancy')!;
  return {
    id: 'lease-1',
    chainId: 'chain-1',
    status: 'draft',
    unitId: 'unit-1',
    unitLabel: 'Unit 1',
    propertyId: 'prop-1',
    propertyName: 'Maple St',
    propertyTimezone: 'UTC',
    calendar: f.terms.calendar,
    startDate: f.terms.startDate,
    endDate: f.terms.endDate,
    moveOutDate: f.terms.moveOutDate,
    rentCents: f.terms.rentCents,
    currency: 'USD',
    rentFrequency: f.terms.frequency,
    billingDay: f.terms.billingDay,
    depositCents: 0,
    openingBalanceCents: 0,
    ledgerStartDate: f.terms.ledgerStartDate,
    moveOutBillingPolicy: f.terms.moveOutBillingPolicy,
    escalation: null,
    tenantCount: 1,
    primaryTenantName: 'Ada Lovelace',
    renewedFromLeaseId: null,
    endReason: null,
    createdAt: now,
    updatedAt: now,
    tenants: [],
    notes: null,
    unitStatus: 'vacant',
    propertyAddress: { line1: '1 Maple St', city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
    chain: [],
    rentSteps: f.terms.rentSteps.map((s) => ({ ...s, id: 'step', source: 'manual', clauseExpectedCents: null, createdAt: now, updatedAt: now })),
    ...overrides,
  };
}

describe('previewActivationCharges — the onboarding guard-rail (docs/PLAN-PHASE3A.md §8)', () => {
  const f9 = scheduleFixtures.find((x) => x.name === 'F9 onboarding an in-flight tenancy')!;
  // `chargesDueForGeneration(terms, today) === buildSchedule(terms, generationHorizon(today))`,
  // so running at `through - LOOKAHEAD` reproduces the fixture's own `expected`
  // array unedited — the same derivation the contract's `generationPlanFixtures`
  // uses (unreachable from `@rms/contract` today — see the note in this PR).
  const today = addDays(f9.through, -GENERATION_LOOKAHEAD_DAYS);

  beforeEach(() => {
    // `previewActivationCharges` reads the clock itself via `localToday` (the one
    // sanctioned clock read) — pin it so the fixture's own `today` is what it sees.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${today}T12:00:00.000Z`));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('F9: matches the fixture rent rows exactly when there is no deposit or opening balance', () => {
    const lease = leaseDetailFromFixture();
    const preview = previewActivationCharges(lease);

    expect(preview.items.map((i) => i.generationKey)).toEqual(f9.expected.map((e) => e.generationKey));
    expect(preview.items.map((i) => i.amountCents)).toEqual(f9.expected.map((e) => e.amountCents));
    expect(preview.totalCents).toBe(f9.expected.reduce((sum, e) => sum + e.amountCents, 0));
  });

  it('F9: the onboarding hazard — a deposit and opening balance due months ago both count as overdue', () => {
    const lease = leaseDetailFromFixture({ depositCents: 50000, openingBalanceCents: 20000 });
    const preview = previewActivationCharges(lease);

    expect(preview.items).toEqual(
      expect.arrayContaining([
        { generationKey: 'deposit', dueDate: lease.startDate, amountCents: 50000 },
        { generationKey: 'opening', dueDate: lease.ledgerStartDate, amountCents: 20000 },
      ]),
    );
    // Deposit (2025-06-15), opening + first rent period (both 2026-03-01) are all
    // before `today` (2026-03-31) — three already-overdue charges in one click,
    // exactly the hazard the activate dialog exists to surface before it commits.
    expect(preview.overdueCount).toBe(3);
    expect(preview.totalCents).toBe(50000 + 20000 + f9.expected.reduce((sum, e) => sum + e.amountCents, 0));
  });

  it('writes no deposit or opening-balance row when either is zero — an absence, not a zero-amount charge', () => {
    const lease = leaseDetailFromFixture({ depositCents: 0, openingBalanceCents: 0 });
    const preview = previewActivationCharges(lease);

    expect(preview.items.some((i) => i.generationKey === 'deposit')).toBe(false);
    expect(preview.items.some((i) => i.generationKey === 'opening')).toBe(false);
  });

  it('reports zero items, never a crash, when the schedule has nothing within the lookahead', () => {
    // A ledger start far beyond the lookahead horizon — nothing is due to generate.
    const lease = leaseDetailFromFixture({
      startDate: '2030-01-01',
      ledgerStartDate: '2030-01-01',
      endDate: null,
    });
    const preview = previewActivationCharges(lease);
    expect(preview.items).toEqual([]);
    expect(preview.totalCents).toBe(0);
    expect(preview.overdueCount).toBe(0);
  });
});
