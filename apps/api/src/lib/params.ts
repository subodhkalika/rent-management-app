import { uuid } from '@rms/contract';
import { notFound } from './errors.js';

/**
 * Validates a path param looks like a UUID before it ever reaches a query.
 *
 * A malformed id can never match a row anyway, so this throws the same `404` as a
 * well-formed id for another org's row (see `notFound` in lib/errors.ts) — the
 * response never reveals *why* the lookup failed.
 */
export function requireUuidParam(value: string, what?: string): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw notFound(what);
  return result.data;
}
