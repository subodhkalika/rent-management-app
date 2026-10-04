import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // Must match the `casing` option passed to `drizzle()` in db/index.ts. Without it,
  // drizzle-kit emits camelCase DDL ("orgId") while the runtime client queries
  // snake_case columns ("org_id") — every query would 42703 against a real DB.
  casing: 'snake_case',
  strict: true,
  verbose: true,
} satisfies Config;
