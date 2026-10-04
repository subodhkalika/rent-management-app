import { describe, expect, it } from 'vitest';
import { formatCentsAsRentInput, parseRentToCents } from './money';

describe('parseRentToCents', () => {
  it('parses zero', () => {
    expect(parseRentToCents('0')).toBe(0);
  });

  it('parses a whole number with no decimals', () => {
    expect(parseRentToCents('1850')).toBe(185000);
  });

  it('parses a value with a thousands separator', () => {
    expect(parseRentToCents('1,850.00')).toBe(185000);
  });

  it('parses a single-digit decimal as tenths', () => {
    expect(parseRentToCents('1850.5')).toBe(185050);
  });

  it('parses multiple thousands separators', () => {
    expect(parseRentToCents('1,234,567.89')).toBe(123456789);
  });

  it('ignores surrounding whitespace', () => {
    expect(parseRentToCents('  42.00  ')).toBe(4200);
  });

  it('rejects a negative amount', () => {
    expect(parseRentToCents('-100')).toBeNull();
  });

  it('rejects a non-numeric string', () => {
    expect(parseRentToCents('abc')).toBeNull();
  });

  it('rejects more than two decimal places', () => {
    expect(parseRentToCents('1.234')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseRentToCents('')).toBeNull();
  });

  it('round-trips without float drift for values prone to it', () => {
    // 1850.00 * 100 is 184999.99999999997 in naive float math — guard the fix.
    expect(parseRentToCents('1850.00')).toBe(185000);
    expect(parseRentToCents('29.99')).toBe(2999);
    expect(parseRentToCents('0.1')).toBe(10);
  });
});

describe('formatCentsAsRentInput', () => {
  it('formats zero', () => {
    expect(formatCentsAsRentInput(0)).toBe('0.00');
  });

  it('formats a whole-dollar amount with two decimals', () => {
    expect(formatCentsAsRentInput(185000)).toBe('1850.00');
  });

  it('formats an amount with cents', () => {
    expect(formatCentsAsRentInput(2999)).toBe('29.99');
  });

  it('pads single-digit cents', () => {
    expect(formatCentsAsRentInput(100)).toBe('1.00');
  });
});

describe('round-trip', () => {
  it('parse -> format -> parse is stable', () => {
    for (const input of ['0', '1850.00', '29.99', '1,234,567.89', '42']) {
      const cents = parseRentToCents(input);
      expect(cents).not.toBeNull();
      const formatted = formatCentsAsRentInput(cents!);
      expect(parseRentToCents(formatted)).toBe(cents);
    }
  });
});
