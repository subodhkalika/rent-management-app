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

/**
 * A signed money amount. Use for BALANCES, not for charge or payment amounts.
 *
 * A balance goes negative the moment a tenant overpays — that is a credit, not an
 * error. Validating a balance with `money` above would reject every credit at the
 * client boundary, where the typed API client parses responses through the contract.
 */
export const moneyDelta = z
  .number()
  .int('Amount must be a whole number of cents')
  .min(-1_000_000_000_00, 'Amount is implausibly large')
  .max(1_000_000_000_00, 'Amount is implausibly large');

/**
 * An aggregate across many rows — lifetime income, a year of rent, a CSV total.
 * `money` caps a single amount at $1M, which a report total legitimately exceeds.
 */
export const moneyTotal = z
  .number()
  .int('Amount must be a whole number of cents')
  .min(-1_000_000_000_00, 'Total is implausibly large')
  .max(1_000_000_000_00, 'Total is implausibly large');

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

/* ---------- dates ---------- */

/**
 * A calendar date with no time component, `YYYY-MM-DD`.
 *
 * Leases, charges and payments are all dated, never timestamped. There is exactly
 * one timezone-sensitive question in this system — "what is today, where the
 * property is" — and it is answered by `localToday` below. Everything else is plain
 * date arithmetic, which is why DST can never produce an off-by-one here.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  // Date.parse does NOT reject 2026-02-30 — it silently rolls over to March 2. Round
  // -tripping the components is the only way to catch an impossible calendar date,
  // and this is exactly the class of bug that makes rent due on a day that does not
  // exist.
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, 'That is not a real date');
export type IsoDate = z.infer<typeof isoDate>;

/** An IANA timezone name, e.g. "Australia/Perth". Validated against the runtime. */
export const timezone = z
  .string()
  .min(1)
  .max(64)
  // Must be an IANA region name, not a bare offset.
  //
  // `Intl` accepts "+05:30" and so would a looser check — but Postgres reads that
  // string with the POSIX sign convention (positive means WEST) while JS reads it
  // with the ISO one, so the two disagree by eleven hours and in opposite
  // directions. The overdue filter runs in SQL and the Overdue badge runs in JS, so
  // an offset zone makes a charge overdue in the list and current on the page.
  // Region names mean the same thing to both.
  // 'UTC' is the one accepted name without a region, and both systems agree on it.
  // It is also the column default every property starts at.
  .refine((v) => v === 'UTC' || v.includes('/'), 'Use a region name like Asia/Kolkata, not an offset')
  .refine((v) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      return true;
    } catch {
      return false;
    }
  }, 'That is not a recognised timezone');
export type Timezone = z.infer<typeof timezone>;

/**
 * Today's calendar date in a given timezone.
 *
 * Never use `new Date().toISOString().slice(0, 10)` for this — that is today in UTC,
 * which is yesterday or tomorrow for most of the world, and would mark rent overdue
 * at the wrong local midnight.
 */
export function localToday(tz: Timezone, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}
