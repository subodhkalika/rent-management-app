const PG_UNIQUE_VIOLATION = '23505';
/** How many `.cause` links to follow before giving up. Drizzle wraps the driver's
 *  error in one `DrizzleQueryError`, so 1 would do — a couple of spares costs
 *  nothing and survives a future wrapper being added in between. */
const MAX_CAUSE_DEPTH = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * True when `err` is a Postgres unique-violation (SQLSTATE 23505).
 *
 * Used to turn a DB-level unique index hit into a `409 conflict` instead of an
 * unhandled 500 — e.g. two units in the same property sharing a label.
 *
 * drizzle-orm (0.45.x) never throws the driver's error directly: every query error
 * is wrapped in a `DrizzleQueryError`, which has no `code` of its own — the
 * underlying `NeonDbError` (which does carry `code: '23505'`) sits at `err.cause`.
 * We walk a bounded number of `.cause` links rather than assuming a fixed depth, so
 * this doesn't silently stop matching if a Drizzle/driver bump adds another layer.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth++) {
    if (current.code === PG_UNIQUE_VIOLATION) return true;
    current = current.cause;
  }
  return false;
}
