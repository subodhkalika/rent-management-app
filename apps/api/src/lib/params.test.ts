import { describe, it, expect } from 'vitest';
import { ApiException } from './errors.js';
import { requireUuidParam } from './params.js';

describe('requireUuidParam', () => {
  it('passes through a well-formed UUID', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    expect(requireUuidParam(id)).toBe(id);
  });

  it('throws a not_found ApiException for a malformed id', () => {
    try {
      requireUuidParam('not-a-uuid');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).code).toBe('not_found');
      expect((err as ApiException).status).toBe(404);
    }
  });

  it('does not leak whether the resource exists in the error message', () => {
    try {
      requireUuidParam('nope', 'Property');
      expect.unreachable();
    } catch (err) {
      expect((err as ApiException).message).toBe('Property not found');
    }
  });
});
