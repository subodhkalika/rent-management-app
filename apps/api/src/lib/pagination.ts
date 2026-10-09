import { isoDate } from '@rms/contract';
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

// Splits the decoded `dueDate|id` pair apart. The DATE half's CALENDAR validity
// (not just its shape) is checked separately below, through the contract's own
// `isoDate` — see that function's comment for why a shape-only regex is not
// enough here.
const DUE_DATE_CURSOR_SHAPE_RE = /^([^|]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * `dueDate` is validated through the contract's `isoDate`, not a `\d{4}-\d{2}-\d{2}`
 * shape regex — a regex accepts `2026-13-45`, which is not shape-invalid but IS
 * calendar-invalid. That string reaches `::date` in the generated SQL
 * (`listChargesQuery`/`listChargesForOrgQuery`), Postgres raises SQLSTATE 22008
 * ("date/time field value out of range"), and `lib/db-errors.ts` only recognises
 * 23505 — so a forged cursor would 500 instead of 400. `isoDate` round-trips the
 * date's components (year/month/day) through `Date.UTC` and checks they survive,
 * which is exactly the check a shape regex cannot express.
 */
export function decodeDueDateCursor(cursor: string): { dueDate: string; id: string } {
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    throw badRequest('Invalid pagination cursor');
  }
  const match = DUE_DATE_CURSOR_SHAPE_RE.exec(decoded);
  if (!match) {
    throw badRequest('Invalid pagination cursor');
  }
  const dueDateResult = isoDate.safeParse(match[1]);
  if (!dueDateResult.success) {
    throw badRequest('Invalid pagination cursor');
  }
  return { dueDate: dueDateResult.data, id: match[2]! };
}
