import { describe, it, expect } from 'vitest';
import { isUniqueViolation } from './db-errors.js';

describe('isUniqueViolation', () => {
  it('is true for a Postgres unique-violation error', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('is false for a different Postgres error code', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
  });

  it('is false for non-error values', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});
