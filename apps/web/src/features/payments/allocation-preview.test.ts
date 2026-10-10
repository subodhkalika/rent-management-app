import { describe, expect, it } from 'vitest';
import { allocationFixtures, type AllocatableCharge, type AllocatablePayment } from '@rms/contract';
import { computeAllocationDelta, previewPaymentAllocation, type PreviewCharge } from './allocation-preview';

/**
 * Ties this app's preview to the SAME oracle the API's SQL is tested against
 * (`allocationFixtures` in the contract, docs/PLAN-PHASE3B.md §3.6 / §10). For
 * every fixture with at least one live payment, we split its payments into
 * "already recorded" and "the one the landlord is about to add", run the preview,
 * and assert the resulting allocation matches the fixture's `expected` exactly —
 * the same assertion the API's integration test makes against the real SQL.
 */
describe('previewPaymentAllocation / computeAllocationDelta — pinned to allocationFixtures', () => {
  const asPreviewCharge = (c: AllocatableCharge): PreviewCharge => ({ ...c, type: 'rent', dueDate: c.dueDate });

  for (const fixture of allocationFixtures) {
    const liveIndex = fixture.payments.findIndex((p) => !p.isVoided);
    if (liveIndex === -1) {
      it.skip(`${fixture.name} (no live payment to preview)`, () => {});
      continue;
    }

    it(`${fixture.name} — after-state matches the fixture's expected allocation`, () => {
      const newPayment = fixture.payments[liveIndex]!;
      const existingPayments: AllocatablePayment[] = fixture.payments.filter((_, i) => i !== liveIndex);
      const charges = fixture.charges.map(asPreviewCharge);

      const deltas = computeAllocationDelta({
        charges,
        existingPayments,
        newPayment: { kind: newPayment.kind, amountCents: newPayment.amountCents },
      });

      for (const charge of fixture.charges) {
        const delta = deltas.find((d) => d.chargeId === charge.id);
        expect(delta, `missing delta for charge ${charge.id}`).toBeDefined();
        expect(delta!.afterAppliedCents).toBe(fixture.expected[charge.id]);
      }
    });
  }

  it('omits charges the payment does not touch, and orders the rest by due date', () => {
    const charges: PreviewCharge[] = [
      { id: 'jan', dueDate: '2026-01-01' as never, amountCents: 100000, isVoided: false, type: 'rent' },
      { id: 'feb', dueDate: '2026-02-01' as never, amountCents: 100000, isVoided: false, type: 'rent' },
      { id: 'mar', dueDate: '2026-03-01' as never, amountCents: 100000, isVoided: false, type: 'rent' },
    ];
    // Jan is already fully paid; this new payment should clear Feb and part of Mar.
    const rows = previewPaymentAllocation({
      charges,
      existingPayments: [{ kind: 'payment', amountCents: 100000, isVoided: false }],
      newPayment: { kind: 'payment', amountCents: 120000 },
    });

    expect(rows.map((r) => r.chargeId)).toEqual(['feb', 'mar']);
    expect(rows[0]!.deltaCents).toBe(100000);
    expect(rows[1]!.deltaCents).toBe(20000);
  });

  it('shows a negative delta when a refund re-opens a previously covered charge', () => {
    const charges: PreviewCharge[] = [
      { id: 'a', dueDate: '2026-01-01' as never, amountCents: 100000, isVoided: false, type: 'rent' },
    ];
    const rows = previewPaymentAllocation({
      charges,
      existingPayments: [{ kind: 'payment', amountCents: 100000, isVoided: false }],
      newPayment: { kind: 'refund', amountCents: 40000 },
    });

    expect(rows).toEqual([{ chargeId: 'a', type: 'rent', dueDate: '2026-01-01', amountCents: 100000, deltaCents: -40000 }]);
  });
});
