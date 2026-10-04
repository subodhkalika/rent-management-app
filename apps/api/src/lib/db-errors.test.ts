import { describe, it, expect } from 'vitest';
import { isUniqueViolation } from './db-errors.js';

describe('isUniqueViolation', () => {
  it('is true for a bare Postgres unique-violation error', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('is true for a drizzle-orm DrizzleQueryError wrapping the driver error', () => {
    // drizzle-orm 0.45.x never throws the driver's error directly — every query
    // error is wrapped in a `DrizzleQueryError`, which has no `code` of its own.
    // The underlying NeonDbError (which does carry `code: '23505'`) sits at
    // `err.cause`. This shape mirrors that wrapping without needing to construct
    // a real DrizzleQueryError (new DrizzleQueryError(query, params, cause)).
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
  });

  it('is true for a real DrizzleQueryError instance', async () => {
    const { DrizzleQueryError } = await import('drizzle-orm/errors');
    const driverError = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const wrapped = new DrizzleQueryError('select 1', [], driverError);
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('is false for a different Postgres error code, wrapped or not', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation({ cause: { code: '23503' } })).toBe(false);
  });

  it('gives up beyond a bounded cause depth rather than looping forever', () => {
    const deeplyNested = { cause: { cause: { cause: { cause: { cause: { code: '23505' } } } } } };
    expect(isUniqueViolation(deeplyNested)).toBe(false);
  });

  it('is false for non-error values', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});
