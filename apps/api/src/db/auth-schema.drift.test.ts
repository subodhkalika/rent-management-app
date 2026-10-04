import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getAuthTables } from 'better-auth/db';
import { organization as organizationPlugin } from 'better-auth/plugins';
import * as schema from './schema.js';

/**
 * Guards the Drizzle auth tables against Better Auth's own expectations.
 *
 * Better Auth's Drizzle adapter looks tables and columns up by name at runtime. A
 * missing one is invisible to the compiler and to every test that does not hit a
 * database — it surfaces as a 500 on the first real sign-in, after deploy.
 *
 * That already happened once: the first migration shipped with `session`, `account`,
 * `verification` and `invitation` absent entirely, so nobody could have signed in.
 * Rather than re-check by hand on every Better Auth upgrade, we ask the library what
 * it needs and diff. No database required.
 */

/** Must mirror the config in `lib/auth.ts` — the plugin list changes what is required. */
const authTables = getAuthTables({
  emailAndPassword: { enabled: true },
  plugins: [organizationPlugin({})],
});

/** Better Auth model key -> our exported Drizzle table. */
const drizzleTables: Record<string, unknown> = {
  user: schema.user,
  session: schema.session,
  account: schema.account,
  verification: schema.verification,
  organization: schema.organization,
  member: schema.member,
  invitation: schema.invitation,
};

describe('Better Auth schema drift', () => {
  it('covers every model Better Auth declares', () => {
    const required = Object.keys(authTables).sort();
    const present = Object.keys(drizzleTables).sort();
    expect(
      present,
      'Better Auth declares a model with no matching Drizzle table. Add it to ' +
        'db/schema.ts and to the map in this test, then run db:generate.',
    ).toEqual(required);
  });

  for (const [model, table] of Object.entries(authTables)) {
    const drizzleTable = drizzleTables[model];
    if (!drizzleTable) continue; // reported by the test above

    it(`"${table.modelName}" has every column Better Auth writes`, () => {
      const ours = new Set(Object.keys(getTableColumns(drizzleTable as never)));
      // Better Auth assumes an `id` primary key on every model without declaring it.
      const required = ['id', ...Object.keys(table.fields)];
      const missing = required.filter((f) => !ours.has(f));

      expect(
        missing,
        `Table "${table.modelName}" is missing ${missing.join(', ')}. The Drizzle ` +
          'adapter resolves columns by name at runtime, so this fails as a 500 on ' +
          'sign-in, not at build time. Add the column and run db:generate.',
      ).toEqual([]);
    });
  }
});
