import { eq } from 'drizzle-orm';
import type { Database } from '../../index.js';
import { organization, tenant, tenantInvite, user } from '../../schema.js';

/**
 * Pre-scope lookups for the invite-accept flow.
 *
 * Every other table in this app is reached through an already-established scope
 * (`orgId` for a landlord, `TenantScope` for a tenant). This directory is the one
 * deliberate exception: at the moment someone opens an invite link, NO scope exists
 * yet — the 256-bit token IS the credential that establishes one. So these functions
 * take no `orgId`, no `tenantId`, no `scope` — only what the caller could possibly
 * have: a token hash, or (after the token has already matched) an email literally
 * copied from the row that matched.
 *
 * Anti-enumeration rule (docs/PLAN-V1.md §1.3): there is no endpoint anywhere — and
 * therefore no function in this file — that takes a tenant id or an email and reports
 * whether an invite exists. `findInviteByTokenHash`'s signature enforces that
 * structurally: it has exactly one input besides `db`, and `portal-invite-lookup.
 * guard.test.ts` asserts that stays true.
 */

export interface InviteLookupRow {
  inviteId: string;
  orgId: string;
  orgName: string;
  tenantId: string;
  tenantFirstName: string;
  tenantLastName: string;
  tenantUserId: string | null;
  tenantDeletedAt: Date | null;
  tenantStatus: (typeof tenant.$inferSelect)['status'];
  /** Snapshotted on the invite at issue time — NOT read from `tenant.email`, which
   *  may have changed since. The account created on accept uses this value. */
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export function findInviteByTokenHashQuery(db: Database, tokenHash: string) {
  return db
    .select({
      inviteId: tenantInvite.id,
      orgId: tenantInvite.orgId,
      orgName: organization.name,
      tenantId: tenant.id,
      tenantFirstName: tenant.firstName,
      tenantLastName: tenant.lastName,
      tenantUserId: tenant.userId,
      tenantDeletedAt: tenant.deletedAt,
      tenantStatus: tenant.status,
      email: tenantInvite.email,
      expiresAt: tenantInvite.expiresAt,
      acceptedAt: tenantInvite.acceptedAt,
      revokedAt: tenantInvite.revokedAt,
    })
    .from(tenantInvite)
    .innerJoin(tenant, eq(tenant.id, tenantInvite.tenantId))
    .innerJoin(organization, eq(organization.id, tenantInvite.orgId))
    .where(eq(tenantInvite.tokenHash, tokenHash))
    .limit(1);
}

/**
 * The ONLY lookup path into `tenant_invite`. Looks up by `tokenHash` equality alone —
 * never by tenant id, never by email. Returns everything the accept flow needs to
 * decide validity (expiry, revocation, acceptance, tenant archival) in one
 * round trip, so the route can fold every failure into one identical 404.
 */
export async function findInviteByTokenHash(db: Database, tokenHash: string): Promise<InviteLookupRow | null> {
  const [row] = await findInviteByTokenHashQuery(db, tokenHash);
  return row ?? null;
}

/**
 * Whether a Better Auth user already exists for a given email.
 *
 * Deliberately NOT an enumeration primitive on its own: it is only ever called from
 * the accept route, after `findInviteByTokenHash` has already matched a token the
 * caller possesses, and only to decide between "create an account" and "409, sign in
 * first" — see docs/PLAN-V1.md §1.3's accepted leak: "the caller already holds a
 * 256-bit token tied to that address, so they knew."
 */
export async function findUserByEmail(db: Database, email: string): Promise<{ id: string } | null> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  return row ?? null;
}
