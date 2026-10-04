/**
 * True when `err` is a Postgres unique-violation (SQLSTATE 23505).
 *
 * Used to turn a DB-level unique index hit into a `409 conflict` instead of an
 * unhandled 500 — e.g. two units in the same property sharing a label.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
