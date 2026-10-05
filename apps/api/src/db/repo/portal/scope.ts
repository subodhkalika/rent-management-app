import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../index.js';
import { organization, tenant } from '../../schema.js';

/** One live tenant identity, across whichever org it belongs to. */
export interface TenancyRow {
  orgId: string;
  orgName: string;
  tenantId: string;
}

/**
 * Query builder, split out from `resolveScope` so a test can assert on its
 * `.toSQL()` without a live database — exactly the pattern `property.ts`, `unit.ts`
 * and `tenant.ts` already use, and for the same reason: this is the ONE query that
 * defines a tenant's entire authorization surface, so "it filters by user_id and
 * excludes archived/deleted rows" needs to be provable against the real query, not
 * a hand-reconstruction of it in a test file that can silently drift.
 */
export function resolveScopeQuery(userId: string, db: Database) {
  return db
    .select({
      orgId: tenant.orgId,
      orgName: organization.name,
      tenantId: tenant.id,
    })
    .from(tenant)
    .innerJoin(organization, eq(organization.id, tenant.orgId))
    .where(and(eq(tenant.userId, userId), isNull(tenant.deletedAt), ne(tenant.status, 'archived')));
}

/**
 * Resolves every LIVE tenant identity a user holds, across every org they rent from.
 * This is the entire authorization surface `requireTenant` (middleware/auth.ts)
 * trusts, and it is also the raw material `GET /v1/me/context` renders as
 * `tenancies`.
 *
 * Deliberately takes `userId`, not `scope: TenantScope` — this is the one function in
 * `db/repo/portal/` that PRODUCES a scope rather than consuming one, so it cannot
 * already take the thing it is building. `portal-tenancy.guard.test.ts` allow-lists
 * exactly this function, by name, for that reason.
 *
 * Excludes archived and soft-deleted tenant rows, and is never cached — called fresh
 * on every request — so a landlord archiving a tenant mid-session revokes portal
 * access on that tenant's very next request (docs/PLAN-V1.md §1.4), the same way
 * `requireAuth` re-checks `member` on every landlord request today.
 */
export async function resolveScope(userId: string, db: Database): Promise<TenancyRow[]> {
  return resolveScopeQuery(userId, db);
}
