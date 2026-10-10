import { describe, it, expect } from 'vitest';
import { allocateFifo, chargeStatusFor, splitBalance } from './ledger.js';
import { allocationFixtures } from './ledger.fixtures.js';

describe('allocateFifo', () => {
  for (const f of allocationFixtures) {
    it(f.name, () => {
      const got = Object.fromEntries(allocateFifo(f).map((r) => [r.id, r.appliedCents]));
      expect(got).toEqual(f.expected);
    });

    it(`${f.name} — balance identity: charged - paid === outstanding - credit`, () => {
      const charged = f.charges.filter((c) => !c.isVoided).reduce((t, c) => t + c.amountCents, 0);
      const paid = f.payments.filter((p) => !p.isVoided)
        .reduce((t, p) => t + (p.kind === 'payment' ? p.amountCents : -p.amountCents), 0);
      const applied = allocateFifo(f);
      const byId = new Map(applied.map((a) => [a.id, a.appliedCents]));
      const outstanding = f.charges.filter((c) => !c.isVoided)
        .reduce((t, c) => t + (c.amountCents - (byId.get(c.id) ?? 0)), 0);
      const credit = Math.max(0, paid - charged);
      expect(charged - paid).toBe(f.expectedBalanceCents);
      // The identity holds whenever net payments are non-negative, which is every
      // state the API will let a landlord create. Where it does not, the fixture says
      // so explicitly rather than the test quietly skipping it.
      expect(outstanding - credit).toBe(f.expectedBalanceCents - (f.identityBreaksBy ?? 0));
      if (f.identityBreaksBy === undefined) expect(paid).toBeGreaterThanOrEqual(0);
    });

    it(`${f.name} — applied is never negative and never exceeds the charge`, () => {
      for (const r of allocateFifo(f)) {
        const src = f.charges.find((c) => c.id === r.id)!;
        expect(r.appliedCents).toBeGreaterThanOrEqual(0);
        expect(r.appliedCents).toBeLessThanOrEqual(src.amountCents);
      }
    });
  }
});

describe('chargeStatusFor', () => {
  const base = { dueDate: '2026-01-01' as never, isVoided: false, today: '2026-02-01' as never };
  it('a zero-amount charge is paid, never overdue', () => {
    expect(chargeStatusFor({ ...base, amountCents: 0, appliedCents: 0 })).toBe('paid');
  });
  it('void wins over everything', () => {
    expect(chargeStatusFor({ ...base, amountCents: 100, appliedCents: 0, isVoided: true })).toBe('void');
  });
  it('the due date itself is not late', () => {
    expect(chargeStatusFor({ ...base, amountCents: 100, appliedCents: 0, today: '2026-01-01' as never })).toBe('unpaid');
    expect(chargeStatusFor({ ...base, amountCents: 100, appliedCents: 0 })).toBe('overdue');
  });
  it('part paid beats overdue', () => {
    expect(chargeStatusFor({ ...base, amountCents: 100, appliedCents: 40 })).toBe('partially_paid');
  });
});

describe('splitBalance', () => {
  it('turns a sign into two words', () => {
    expect(splitBalance(50000)).toEqual({ owedCents: 50000, creditCents: 0 });
    expect(splitBalance(-50000)).toEqual({ owedCents: 0, creditCents: 50000 });
    expect(splitBalance(0)).toEqual({ owedCents: 0, creditCents: 0 });
  });
});
