import { z } from 'zod';

/* ---------- ids ---------- */

/**
 * UUID v7 — time-ordered, so primary keys cluster by creation time and index
 * locality stays good. `crypto.randomUUID()` is v4 (random) and would scatter
 * writes across the index, so we build v7 by hand.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = 0x70 | (bytes[6]! & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8]! & 0x3f); // RFC 4122 variant

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const uuid = z.string().uuid();
export type Uuid = z.infer<typeof uuid>;

/* ---------- money ---------- */

/**
 * Money is always an integer count of minor units (cents/paise). Never a float —
 * 0.1 + 0.2 !== 0.3, and rent ledgers must balance exactly.
 */
export const money = z
  .number()
  .int('Amount must be a whole number of cents')
  .nonnegative('Amount cannot be negative')
  .max(1_000_000_00, 'Amount is implausibly large');

export const currency = z.enum(['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD']);
export type Currency = z.infer<typeof currency>;

export function formatMoney(cents: number, code: Currency, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: code })
    .format(cents / 100);
}

/* ---------- errors ---------- */

export const errorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'validation_failed',
  'rate_limited',
  'internal',
]);
export type ErrorCode = z.infer<typeof errorCode>;

export const apiError = z.object({
  error: z.object({
    code: errorCode,
    message: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

export const httpStatusFor: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  internal: 500,
};

/* ---------- pagination ---------- */

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

export function paged<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
