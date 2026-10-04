import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { ApiClientError } from '@/lib/api';

/**
 * Maps `ApiClientError.details` (field name -> messages) onto a react-hook-form
 * form's fields, so a server-side validation failure shows up next to the field it
 * belongs to instead of as a generic toast. Returns whether it found per-field
 * details to apply — the caller should fall back to a toast when it returns false.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
): boolean {
  if (!(error instanceof ApiClientError) || !error.details) return false;

  const entries = Object.entries(error.details);
  if (entries.length === 0) return false;

  for (const [field, messages] of entries) {
    if (!messages?.length) continue;
    setError(field as Path<T>, { type: 'server', message: messages[0] });
  }
  return true;
}

/** A message safe to show in a toast for any failed mutation. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return 'Something went wrong. Please try again.';
}

/**
 * A text input needs a string to stay controlled, so an empty optional field (notes,
 * address line 2, ...) lives in form state as `''`. The contract types these fields
 * as `optional()` (absent, not an empty string) on write and `nullable()` on read —
 * so convert `''` to `undefined` right before sending, instead of letting `''` and
 * `null`/absent diverge as two different "no value" states.
 */
export function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
