import { and, eq } from 'drizzle-orm';
import type { Database } from '../../index.js';
import { member, organization } from '../../schema.js';

/**
 * Direct access to Better Auth's OWN `organization`/`member` tables — see
 * user.ts's module comment for why this directory exists and what it may touch.
 */

/** The org's display name alone — used for the invite email's "<org> invited you"
 *  line. Not scoped by a caller-held `orgId` filter in the usual sense (there is no
 *  cross-org data here to leak: an organization's own name is not a secret), but the
 *  `orgId` IS still the caller's own session value, never read from the request. */
export async function getOrganizationName(db: Database, orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return row?.name ?? null;
}

export interface LandlordMembership {
  orgId: string;
  orgName: string;
  role: string;
}

/**
 * A user's membership in one specific org — always called with the org id from
 * their OWN verified session (`session.session.activeOrganizationId`), never one
 * supplied by a request. Returns `null` if that membership does not exist, which is
 * exactly the "no landlord context" case `GET /v1/me/context` needs to represent.
 */
export async function getLandlordMembership(
  db: Database,
  userId: string,
  orgId: string,
): Promise<LandlordMembership | null> {
  const [row] = await db
    .select({ orgId: organization.id, orgName: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  return row ?? null;
}
