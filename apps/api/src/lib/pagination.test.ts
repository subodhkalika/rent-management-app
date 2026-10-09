import { describe, it, expect } from 'vitest';
import { ApiException } from './errors.js';
import { encodeCursor, decodeCursor, encodeDueDateCursor, decodeDueDateCursor } from './pagination.js';

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

describe('due-date pagination cursor — charges are ordered (due_date, id), not id alone', () => {
  const dueDate = '2026-04-01';
  const id = '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f';

  it('round-trips a (dueDate, id) pair', () => {
    expect(decodeDueDateCursor(encodeDueDateCursor(dueDate, id))).toEqual({ dueDate, id });
  });

  it('is opaque: the encoded form is not the raw pair', () => {
    expect(encodeDueDateCursor(dueDate, id)).not.toContain(dueDate);
  });

  it('rejects a cursor that is not valid base64', () => {
    expect(() => decodeDueDateCursor('!!!not-base64!!!')).toThrow(ApiException);
  });

  it('rejects a cursor missing the due-date half', () => {
    expect(() => decodeDueDateCursor(btoa(id))).toThrow(ApiException);
  });

  it('rejects a cursor missing the id half', () => {
    expect(() => decodeDueDateCursor(btoa(dueDate))).toThrow(ApiException);
  });

  it('rejects a cursor whose id half is not a UUID', () => {
    expect(() => decodeDueDateCursor(btoa(`${dueDate}|not-a-uuid`))).toThrow(ApiException);
  });

  /**
   * THE regression this fix closes: `2026-13-45` matches a shape-only
   * `\d{4}-\d{2}-\d{2}` regex (it IS four-two-two digits) but is not a real
   * calendar date. Before routing this through the contract's `isoDate`, a
   * forged cursor like this reached `::date` in the generated SQL, Postgres
   * raised SQLSTATE 22008 ("date/time field value out of range"), and
   * `lib/db-errors.ts` — which only recognises 23505 — let it surface as an
   * unhandled 500 instead of this 400.
   */
  it('rejects a cursor whose date half is shape-valid but not a real calendar date', () => {
    expect(() => decodeDueDateCursor(btoa(`2026-13-45|${id}`))).toThrow(ApiException);
    try {
      decodeDueDateCursor(btoa(`2026-13-45|${id}`));
      expect.unreachable();
    } catch (err) {
      expect((err as ApiException).code).toBe('bad_request');
      expect((err as ApiException).status).toBe(400);
    }
  });

  it('rejects 2026-02-30 — shape-valid, but February never has a 30th', () => {
    expect(() => decodeDueDateCursor(btoa(`2026-02-30|${id}`))).toThrow(ApiException);
  });

  it('throws a bad_request ApiException with a 400 status', () => {
    try {
      decodeDueDateCursor('garbage');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).code).toBe('bad_request');
      expect((err as ApiException).status).toBe(400);
    }
  });
});
