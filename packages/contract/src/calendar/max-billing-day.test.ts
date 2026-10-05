import { describe, it, expect } from 'vitest';
import { MAX_BILLING_DAY, MAX_BILLING_DAY_ANY, calendarSystem } from './index.js';

describe('MAX_BILLING_DAY_ANY', () => {
  it('equals the widest ceiling across every calendar', () => {
    const widest = Math.max(...Object.values(MAX_BILLING_DAY));
    expect(
      MAX_BILLING_DAY_ANY,
      'MAX_BILLING_DAY_ANY is written as a literal so it cannot be undefined at ' +
        'module-init time under a bundler. That makes it capable of going stale, ' +
        'which is what this test exists to prevent. Add the new calendar to ' +
        'MAX_BILLING_DAY and update the literal together.',
    ).toBe(widest);
  });

  it('covers every calendar the enum declares', () => {
    // A calendar added to the enum but missing from MAX_BILLING_DAY would make the
    // check above pass while leaving that calendar's billingDay unbounded.
    expect(Object.keys(MAX_BILLING_DAY).sort()).toEqual([...calendarSystem.options].sort());
  });
});
