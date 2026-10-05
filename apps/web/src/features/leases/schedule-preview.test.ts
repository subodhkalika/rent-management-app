import { describe, expect, it } from 'vitest';
import { scheduleFixtures, compareIsoDate, type LeaseSummary } from '@rms/contract';
import { previewSchedule, defaultPreviewThrough, type PreviewLeaseInput } from './schedule-preview';

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

describe('defaultPreviewThrough', () => {
  it('anchors a long-running rolling lease on TODAY, not on its start date (regression: HIGH 5)', () => {
    // A lease that started five years ago, still rolling (no endDate). Anchoring
    // on `startDate` alone — the original bug — produced a window that ended two
    // years in the past: no current period, no "next due" row, for the ordinary
    // state of any long-running tenancy.
    const startDate = '2021-01-01';
    const today = new Date('2026-06-15T12:00:00.000Z');

    const through = defaultPreviewThrough(startDate, null, 'UTC', today);

    expect(compareIsoDate(through, '2026-06-15')).toBeGreaterThanOrEqual(0);
  });

  it("uses the PROPERTY's timezone for today, not the runner's", () => {
    // 2026-01-15T23:00:00Z is still 15 Jan in UTC but already 16 Jan in Kiritimati
    // (UTC+14) — the same cross-timezone proof as next-due.test.ts.
    const now = new Date('2026-01-15T23:00:00.000Z');
    const startDate = '2020-01-01';

    const utcThrough = defaultPreviewThrough(startDate, null, 'UTC', now);
    const kiritimatiThrough = defaultPreviewThrough(startDate, null, 'Pacific/Kiritimati', now);

    expect(compareIsoDate(kiritimatiThrough, utcThrough)).toBeGreaterThan(0);
  });

  it('never asks for a `through` beyond the backend\'s 10-year-from-start sanity bound (regression: HIGH 5)', () => {
    // A 20-year fixed-term lease. Before the fix, `through = endDate` unconditionally
    // — 20 years out — which the route rejects with a 422, breaking the schedule
    // panel permanently for both the landlord and the tenant.
    const startDate = '2020-01-01';
    const endDate = '2040-01-01';

    const through = defaultPreviewThrough(startDate, endDate, 'UTC', new Date('2026-01-01T00:00:00.000Z'));

    // 2020-01-01 + 3653 days ("ten years", apps/api's own sanity constant) is
    // exactly 2030-01-01 — three leap days (2020, 2024, 2028) land inside the span.
    expect(compareIsoDate(through, '2030-01-01')).toBeLessThanOrEqual(0);
  });

  it('still clamps to endDate when the term ends before the sanity bound', () => {
    const through = defaultPreviewThrough(
      '2026-01-01',
      '2026-06-10',
      'UTC',
      new Date('2026-01-15T00:00:00.000Z'),
    );

    expect(through).toBe('2026-06-10');
  });
});
