import { describe, it, expect } from 'vitest';
import { ApiException } from './errors.js';
import { encodeCursor, decodeCursor } from './pagination.js';

describe('pagination cursor', () => {
  it('round-trips a UUID through encode/decode', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it('is opaque: the encoded form is not the raw id', () => {
    const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';
    expect(encodeCursor(id)).not.toBe(id);
  });

  it('rejects a cursor that is not valid base64', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow(ApiException);
  });

  it('rejects a cursor that decodes to something other than a UUID', () => {
    const notAUuid = btoa('hello world');
    expect(() => decodeCursor(notAUuid)).toThrow(ApiException);
  });

  it('throws a bad_request ApiException with a 400 status', () => {
    try {
      decodeCursor('garbage');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).code).toBe('bad_request');
      expect((err as ApiException).status).toBe(400);
    }
  });
});
