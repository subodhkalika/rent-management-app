import { and, eq } from 'drizzle-orm';
import type { UpdatePortalProfileBody } from '@rms/contract';
import type { Database } from '../../index.js';
import { organization, tenant } from '../../schema.js';
import type { TenantScope } from '../../../types.js';

/**
 * Everything `portalProfile` (packages/contract/src/portal.ts) needs. Deliberately
 * excludes `tenant.notes` — it is landlord-private and has no column here at all, not
 * merely one the mapper happens to skip.
 */
export interface PortalProfileRow {
  tenantId: string;
  orgId: string;
  orgName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  remindersOptedOut: boolean;
}

/**
 * "Verify-then-scope" (docs/PLAN-V1.md §1.4): the only thing trusted from the
 * request is `tenantId`, a bare UUID a client could set to anyone's. It is checked
 * against `scope.pairs` — the caller's own live tenant identities, resolved from the
 * session by `requireTenant` — BEFORE it is allowed to appear in a WHERE clause. If
 * it is not in scope, this returns `null` (never throws), so the route 404s exactly
 * like "resource does not exist" — the attacker cannot distinguish "not yours" from
 * "never existed".
 */
function resolvePair(scope: TenantScope, tenantId: string) {
  return scope.pairs.find((p) => p.tenantId === tenantId) ?? null;
}

export function getProfileQuery(scope: TenantScope, db: Database, tenantId: string, orgId: string) {
  return db
    .select({
      tenantId: tenant.id,
      orgId: tenant.orgId,
      orgName: organization.name,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      email: tenant.email,
      phone: tenant.phone,
      emergencyContactName: tenant.emergencyContactName,
      emergencyContactPhone: tenant.emergencyContactPhone,
      remindersOptedOut: tenant.remindersOptedOut,
    })
    .from(tenant)
    .innerJoin(organization, eq(organization.id, tenant.orgId))
    .where(and(eq(tenant.orgId, orgId), eq(tenant.id, tenantId)))
    .limit(1);
}

export async function getProfile(
  scope: TenantScope,
  db: Database,
  tenantId: string,
): Promise<PortalProfileRow | null> {
  const pair = resolvePair(scope, tenantId);
  if (!pair) return null;

  const [row] = await getProfileQuery(scope, db, pair.tenantId, pair.orgId);
  return row ?? null;
}

export function updateProfileQuery(
  scope: TenantScope,
  db: Database,
  tenantId: string,
  orgId: string,
  patch: UpdatePortalProfileBody,
) {
  const values: Partial<typeof tenant.$inferInsert> = { updatedAt: new Date() };
  if (patch.phone !== undefined) values.phone = patch.phone ?? null;
  if (patch.emergencyContactName !== undefined) values.emergencyContactName = patch.emergencyContactName ?? null;
  if (patch.emergencyContactPhone !== undefined) values.emergencyContactPhone = patch.emergencyContactPhone ?? null;
  if (patch.remindersOptedOut !== undefined) values.remindersOptedOut = patch.remindersOptedOut;

  return db
    .update(tenant)
    .set(values)
    .where(and(eq(tenant.orgId, orgId), eq(tenant.id, tenantId)))
    .returning({ id: tenant.id });
}

/** The only fields a tenant may change about themselves — not email, not the name on
 *  the lease. Enforced upstream by `updatePortalProfileBody` (the contract), not
 *  re-validated here. */
export async function updateProfile(
  scope: TenantScope,
  db: Database,
  tenantId: string,
  patch: UpdatePortalProfileBody,
): Promise<PortalProfileRow | null> {
  const pair = resolvePair(scope, tenantId);
  if (!pair) return null;

  await updateProfileQuery(scope, db, pair.tenantId, pair.orgId, patch);
  return getProfile(scope, db, tenantId);
}
