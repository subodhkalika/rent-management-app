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

/**
 * The charge list is ordered `(due_date, id)`, not `id` alone (`charge_lease_due_idx`
 * / `charge_org_due_idx` — see schema.ts), so a single-UUID cursor cannot express a
 * page boundary here: two charges can share a due date, and `id` alone only breaks
 * the tie, never leads the sort. The cursor is the last row's `(dueDate, id)` pair,
 * base64-wrapped the same opaque way `encodeCursor` wraps a bare id.
 */
export function encodeDueDateCursor(dueDate: string, id: string): string {
  return btoa(`${dueDate}|${id}`);
}

const DUE_DATE_CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function decodeDueDateCursor(cursor: string): { dueDate: string; id: string } {
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
  const match = DUE_DATE_CURSOR_RE.exec(decoded);
  if (!match) {
    throw badRequest('Invalid pagination cursor');
  }
  return { dueDate: match[1]!, id: match[2]! };
}
