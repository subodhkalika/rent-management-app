import { badRequest } from './errors.js';

/**
 * Keyset pagination cursor.
 *
 * IDs are UUIDv7 — time-ordered — so `ORDER BY id ASC` plus `WHERE id > cursor` gives
 * a stable, efficient page boundary with no OFFSET scan and no drift when rows are
 * inserted between page fetches. The cursor is just the last row's id, base64-wrapped
 * so it reads as an opaque token to API consumers rather than an exposed column.
 */
export function encodeCursor(id: string): string {
  return btoa(id);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeCursor(cursor: string): string {
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
  if (!UUID_RE.test(decoded)) {
    throw badRequest('Invalid pagination cursor');
  }
  return decoded;
}
