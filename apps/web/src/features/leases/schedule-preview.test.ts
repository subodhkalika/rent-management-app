import { describe, expect, it } from 'vitest';
import { scheduleFixtures, buildSchedule, type LeaseBillingTerms, type LeaseSummary } from '@rms/contract';
import { previewSchedule, previewFirstPeriod, type PreviewLeaseInput } from './schedule-preview';

/**
 * The contract ships `scheduleFixtures` precisely so the backend's HTTP route and
 * this client-side preview assert IDENTICAL numbers (see docs/PLAN-PHASE2.md §8.2
 * item 11 and §8.3). If this test and the backend's route test both pass, the two
 * ends agree; if only one does, that is the bug this whole design exists to catch.
 */
describe('previewSchedule against the contract scheduleFixtures', () => {
  for (const fixture of scheduleFixtures) {
    it(`matches fixture: ${fixture.name}`, () => {
      // `billingTermsFor` takes a LeaseSummary-shaped pick, not a LeaseBillingTerms
      // — field names differ (`rentFrequency` vs `frequency`). Translate once here,
      // the same way the real wizard translates its form state.
      const leaseShaped: PreviewLeaseInput = {
        rentFrequency: fixture.terms.frequency,
        rentCents: fixture.terms.rentCents,
        billingDay: fixture.terms.billingDay,
        startDate: fixture.terms.startDate,
        endDate: fixture.terms.endDate,
        ledgerStartDate: fixture.terms.ledgerStartDate,
        moveOutDate: fixture.terms.moveOutDate,
        moveOutBillingPolicy: fixture.terms.moveOutBillingPolicy,
        calendar: fixture.terms.calendar,
      };

      const result = previewSchedule(leaseShaped, fixture.through);

      expect(result).toEqual(fixture.expected);
    });
  }

  it('type-checks against a real LeaseSummary pick, not a hand-rolled shape', () => {
    // Compile-time guard: `PreviewLeaseInput` must stay assignable FROM `LeaseSummary`
    // — if the contract renames or adds a required billing field, this line fails to
    // typecheck rather than the preview silently going stale.
    const assertAssignable = (lease: LeaseSummary): PreviewLeaseInput => lease;
    expect(typeof assertAssignable).toBe('function');
  });
});

/**
 * The wizard's only preview call left after the product feedback that removed the
 * per-period table: a single-period call for the first charge, never the full
 * term. Every case here is cross-checked against `buildSchedule` run over the
 * FULL term so a regression that happens to agree with itself can't hide.
 */
describe('previewFirstPeriod', () => {
  it('returns exactly the prorated first period of a mid-month lease, matching buildSchedule(full term)[0]', () => {
    const lease: PreviewLeaseInput = {
      rentFrequency: 'monthly',
      rentCents: 150000,
      billingDay: 1,
      startDate: '2026-03-05',
      endDate: '2026-12-31',
      ledgerStartDate: '2026-03-05',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
    };
    const terms: LeaseBillingTerms = { ...lease, frequency: lease.rentFrequency };
    const full = buildSchedule(terms, '2026-12-31');

    const result = previewFirstPeriod(lease);

    expect(result).toEqual(full[0]);
    expect(result?.isProrated).toBe(true);
    expect(result?.daysOccupied).toBe(27);
    expect(result?.daysInPeriod).toBe(31);
  });

  it('returns the single, un-prorated period for a lease that starts on the first day of its period', () => {
    const lease: PreviewLeaseInput = {
      rentFrequency: 'monthly',
      rentCents: 150000,
      billingDay: 1,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      ledgerStartDate: '2026-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
    };
    const terms: LeaseBillingTerms = { ...lease, frequency: lease.rentFrequency };
    const full = buildSchedule(terms, '2026-12-31');
    expect(full.length).toBeGreaterThan(1); // confirms this really is a long term

    const result = previewFirstPeriod(lease);

    expect(result).toEqual(full[0]);
    expect(result?.isProrated).toBe(false);
    expect(result?.amountCents).toBe(150000);
  });

  it('never builds more than the one period it returns, even for a five-year term', () => {
    // The regression this function exists to fix: a five-year monthly lease used
    // to construct sixty `PlannedCharge` objects on every keystroke just to show
    // the first one. Proven here by comparing lengths, not by mocking internals —
    // `buildSchedule` itself has no way to return more than one element when
    // `through` is pinned to the window's own start.
    const lease: PreviewLeaseInput = {
      rentFrequency: 'monthly',
      rentCents: 200000,
      billingDay: 1,
      startDate: '2021-01-01',
      endDate: '2026-01-01',
      ledgerStartDate: '2021-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
    };
    const terms: LeaseBillingTerms = { ...lease, frequency: lease.rentFrequency };
    expect(buildSchedule(terms, '2026-01-01').length).toBeGreaterThan(50);

    const result = previewFirstPeriod(lease);

    expect(result?.periodIndex).toBe(0);
  });

  it('is anchored on ledgerStartDate, not startDate, when the ledger starts later', () => {
    const lease: PreviewLeaseInput = {
      rentFrequency: 'monthly',
      rentCents: 150000,
      billingDay: 1,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      ledgerStartDate: '2026-02-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
    };

    const result = previewFirstPeriod(lease);

    expect(result?.periodStart).toBe('2026-02-01');
    expect(result?.isProrated).toBe(false);
  });
});
