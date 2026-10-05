import { describe, expect, it } from 'vitest';
import { scheduleFixtures, type LeaseSummary } from '@rms/contract';
import { previewSchedule, type PreviewLeaseInput } from './schedule-preview';

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
