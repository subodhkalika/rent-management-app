const PG_UNIQUE_VIOLATION = '23505';
const PG_CHECK_VIOLATION = '23514';
/** How many `.cause` links to follow before giving up. Drizzle wraps the driver's
 *  error in one `DrizzleQueryError`, so 1 would do — a couple of spares costs
 *  nothing and survives a future wrapper being added in between. */
const MAX_CAUSE_DEPTH = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Walks a bounded number of `.cause` links looking for a Postgres SQLSTATE, the
 *  shared mechanics behind both `isUniqueViolation` and `isCheckViolation` below. */
function hasSqlState(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth++) {
    if (current.code === code) return true;
    current = current.cause;
  }
  return false;
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
  return hasSqlState(err, PG_UNIQUE_VIOLATION);
}

/**
 * True when `err` is a Postgres CHECK-violation (SQLSTATE 23514).
 *
 * PLAN-PHASE3B.md §2.4: `payment_amount_ck` (`amount_cents > 0`) is unreachable
 * through the API — the contract's `paymentAmountCents` already refines `> 0` — but
 * 3a predicted exactly this gap for `charge_amount_ck` and 3b adds two more CHECKs
 * (`payment_amount_ck` here, plus the existing charge ones) without ever closing it.
 * Without this branch a CHECK violation that DOES reach the database (a direct
 * repo-level caller, a future schema change that loosens the contract's own refine)
 * surfaces as an unhandled 500 instead of a 422 naming the real field.
 */
export function isCheckViolation(err: unknown): boolean {
  return hasSqlState(err, PG_CHECK_VIOLATION);
}
