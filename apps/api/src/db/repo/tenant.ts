import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7, type CreateTenantBody, type UpdateTenantBody } from '@rms/contract';
import type { Database } from '../index.js';
import { tenant, tenantInvite, user } from '../schema.js';
import { conflict } from '../../lib/errors.js';
import { decodeCursor } from '../../lib/pagination.js';
import { isUniqueViolation } from '../../lib/db-errors.js';

/**
 * A tenant row with the two pieces of portal state folded in:
 * - `portalEmail`: the bound login's email, via a left join on `user` — null until
 *   an invite is accepted.
 * - `latestInvite*`: the three columns of the most recent `tenant_invite` row for
 *   this tenant (if any), via a `DISTINCT ON` derived table. `mapTenant`
 *   (lib/mappers.ts) turns these into the contract's `portalAccess` enum — kept out
 *   of SQL so the state machine is one small, directly-unit-testable function
 *   instead of a CASE expression nobody can safely change.
 */
export interface TenantRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  notes: string | null;
  status: (typeof tenant.$inferSelect)['status'];
  remindersOptedOut: boolean;
  userId: string | null;
  portalEmail: string | null;
  latestInviteAcceptedAt: Date | null;
  latestInviteRevokedAt: Date | null;
  latestInviteExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Shared selection, reused by list/get/create/update so the join shape is defined
 *  exactly once. */
function tenantColumns(orgId: string, db: Database) {
  // The most recent invite per tenant, scoped to this org. `selectDistinctOn` keeps
  // this to one extra join for an entire page of tenants, instead of one correlated
  // subquery per row.
  const latestInvite = db
    .selectDistinctOn(
      [tenantInvite.tenantId],
      {
        tenantId: tenantInvite.tenantId,
        acceptedAt: tenantInvite.acceptedAt,
        revokedAt: tenantInvite.revokedAt,
        expiresAt: tenantInvite.expiresAt,
      },
    )
    .from(tenantInvite)
    .where(eq(tenantInvite.orgId, orgId))
    .orderBy(tenantInvite.tenantId, desc(tenantInvite.createdAt))
    .as('latest_invite');

  return {
    columns: {
      id: tenant.id,
      firstName: tenant.firstName,
      lastName: tenant.lastName,
      email: tenant.email,
      phone: tenant.phone,
      emergencyContactName: tenant.emergencyContactName,
      emergencyContactPhone: tenant.emergencyContactPhone,
      notes: tenant.notes,
      status: tenant.status,
      remindersOptedOut: tenant.remindersOptedOut,
      userId: tenant.userId,
      portalEmail: user.email,
      latestInviteAcceptedAt: latestInvite.acceptedAt,
      latestInviteRevokedAt: latestInvite.revokedAt,
      latestInviteExpiresAt: latestInvite.expiresAt,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
    },
    latestInvite,
  };
}

export function listTenantsQuery(
  orgId: string,
  db: Database,
  opts: { limit: number; cursor?: string },
) {
  const { columns, latestInvite } = tenantColumns(orgId, db);
  const conditions = [eq(tenant.orgId, orgId), isNull(tenant.deletedAt)];
  if (opts.cursor) conditions.push(gt(tenant.id, decodeCursor(opts.cursor)));

  return db
    .select(columns)
    .from(tenant)
    .leftJoin(user, eq(user.id, tenant.userId))
    .leftJoin(latestInvite, eq(latestInvite.tenantId, tenant.id))
    .where(and(...conditions))
    .orderBy(asc(tenant.id))
    .limit(opts.limit + 1);
}

export async function listTenants(
  orgId: string,
  db: Database,
  opts: { limit: number; cursor?: string },
): Promise<{ rows: TenantRow[]; hasMore: boolean }> {
  const rows = await listTenantsQuery(orgId, db, opts);
  const hasMore = rows.length > opts.limit;
  return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
}

export function getTenantQuery(orgId: string, db: Database, id: string) {
  const { columns, latestInvite } = tenantColumns(orgId, db);

  return db
    .select(columns)
    .from(tenant)
    .leftJoin(user, eq(user.id, tenant.userId))
    .leftJoin(latestInvite, eq(latestInvite.tenantId, tenant.id))
    .where(and(eq(tenant.orgId, orgId), eq(tenant.id, id), isNull(tenant.deletedAt)))
    .limit(1);
}

export async function getTenant(orgId: string, db: Database, id: string): Promise<TenantRow | null> {
  const [row] = await getTenantQuery(orgId, db, id);
  return row ?? null;
}

/** Insert query builder, split out so a test can assert on its `.toSQL()` — see
 *  property.ts / unit.ts for the same pattern and the reasoning behind it. */
export function createTenantQuery(orgId: string, db: Database, id: string, data: CreateTenantBody) {
  return db.insert(tenant).values({
    id,
    orgId,
    firstName: data.firstName,
    lastName: data.lastName,
    email: data.email ?? null,
    phone: data.phone ?? null,
    emergencyContactName: data.emergencyContactName ?? null,
    emergencyContactPhone: data.emergencyContactPhone ?? null,
    notes: data.notes ?? null,
    status: data.status,
  });
}

export async function createTenant(orgId: string, db: Database, data: CreateTenantBody): Promise<TenantRow> {
  const id = uuidv7();
  try {
    await createTenantQuery(orgId, db, id, data);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`A tenant with email "${data.email ?? ''}" already exists in this organization`);
    }
    throw err;
  }

  const created = await getTenant(orgId, db, id);
  if (!created) throw new Error('Tenant not found immediately after insert');
  return created;
}

/** Update query builder, split out for the same `.toSQL()`-assertion reason as
 *  `property.ts` / `unit.ts`: a dropped `eq(orgId, ...)` here would let any caller
 *  holding a tenant UUID mutate another org's tenant. */
export function updateTenantQuery(orgId: string, db: Database, id: string, data: UpdateTenantBody) {
  const patch: Partial<typeof tenant.$inferInsert> = { updatedAt: new Date() };
  if (data.firstName !== undefined) patch.firstName = data.firstName;
  if (data.lastName !== undefined) patch.lastName = data.lastName;
  if (data.email !== undefined) patch.email = data.email ?? null;
  if (data.phone !== undefined) patch.phone = data.phone ?? null;
  if (data.emergencyContactName !== undefined) patch.emergencyContactName = data.emergencyContactName ?? null;
  if (data.emergencyContactPhone !== undefined) patch.emergencyContactPhone = data.emergencyContactPhone ?? null;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;
  if (data.status !== undefined) patch.status = data.status;

  return db
    .update(tenant)
    .set(patch)
    .where(and(eq(tenant.orgId, orgId), eq(tenant.id, id), isNull(tenant.deletedAt)))
    .returning({ id: tenant.id });
}

export async function updateTenant(
  orgId: string,
  db: Database,
  id: string,
  data: UpdateTenantBody,
): Promise<TenantRow | null> {
  let result: { id: string }[];
  try {
    result = await updateTenantQuery(orgId, db, id, data);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`A tenant with email "${data.email ?? ''}" already exists in this organization`);
    }
    throw err;
  }

  if (result.length === 0) return null;
  return getTenant(orgId, db, id);
}

/** Soft-delete + archive query builder, split out for the same reason as above. */
export function archiveTenantQuery(orgId: string, db: Database, id: string) {
  return db
    .update(tenant)
    .set({ status: 'archived', deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(tenant.orgId, orgId), eq(tenant.id, id), isNull(tenant.deletedAt)))
    .returning({ id: tenant.id });
}

/**
 * Archives a tenant: soft delete + `status = 'archived'`. Drops them out of
 * `requireTenant`'s scope on their next request (docs/PLAN-V1.md §5.2).
 *
 * The plan also requires this to 409 while any lease on the tenant is `active` — no
 * `lease` table exists yet (Phase 2), so that check is not implemented here. Noted,
 * not silently skipped.
 */
export async function archiveTenant(orgId: string, db: Database, id: string): Promise<boolean> {
  const result = await archiveTenantQuery(orgId, db, id);
  return result.length > 0;
}

/* ---------- portal invites (still landlord-scoped: issuing/revoking is a landlord action) ---------- */

export type TenantInviteRow = typeof tenantInvite.$inferSelect;

/** True while an invite is still usable: not accepted, not revoked, not expired. */
function liveInvite(now: Date) {
  return and(isNull(tenantInvite.acceptedAt), isNull(tenantInvite.revokedAt), sql`${tenantInvite.expiresAt} > ${now}`);
}

export function revokeLiveInvitesQuery(orgId: string, db: Database, tenantId: string, now: Date = new Date()) {
  return db
    .update(tenantInvite)
    .set({ revokedAt: now })
    .where(and(eq(tenantInvite.orgId, orgId), eq(tenantInvite.tenantId, tenantId), liveInvite(now)));
}

/** Revokes any outstanding (not yet accepted/expired/revoked) invite for this tenant.
 *  Used both by "resend = revoke + reissue" and by `revokePortalAccess`. */
export async function revokeLiveInvites(orgId: string, db: Database, tenantId: string): Promise<void> {
  await revokeLiveInvitesQuery(orgId, db, tenantId);
}

export function createInviteQuery(
  orgId: string,
  db: Database,
  id: string,
  data: {
    tenantId: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
    createdByUserId: string;
  },
) {
  return db.insert(tenantInvite).values({
    id,
    orgId,
    tenantId: data.tenantId,
    email: data.email,
    tokenHash: data.tokenHash,
    expiresAt: data.expiresAt,
    createdByUserId: data.createdByUserId,
  });
}

/** Revokes any live invite, then issues a fresh one. "Resend" IS "invite again" —
 *  docs/PLAN-V1.md §1.3. Two statements (no interactive transactions on the Neon
 *  HTTP driver — db/index.ts): revoke first, so a torn failure leaves at most the
 *  old invite dead and no new one, never two simultaneously live invites. */
export async function createInvite(
  orgId: string,
  db: Database,
  tenantId: string,
  data: { email: string; tokenHash: string; expiresAt: Date; createdByUserId: string },
): Promise<TenantInviteRow> {
  await revokeLiveInvites(orgId, db, tenantId);

  const id = uuidv7();
  await createInviteQuery(orgId, db, id, { tenantId, ...data });

  const [row] = await db
    .select()
    .from(tenantInvite)
    .where(and(eq(tenantInvite.orgId, orgId), eq(tenantInvite.id, id)))
    .limit(1);
  if (!row) throw new Error('Invite not found immediately after insert');
  return row;
}

export function bindTenantUserQuery(orgId: string, db: Database, tenantId: string, userId: string) {
  return db
    .update(tenant)
    .set({ userId, updatedAt: new Date() })
    .where(and(eq(tenant.orgId, orgId), eq(tenant.id, tenantId), isNull(tenant.userId)))
    .returning({ id: tenant.id });
}

/** Binds a tenant record to a (now-verified) login. Scoped by `isNull(tenant.userId)`
 *  so this can never silently steal a tenant record that is already bound to someone
 *  else — the caller (the invite-accept flow) checks that case explicitly and
 *  returns 409 before ever calling this. */
export async function bindTenantUser(
  orgId: string,
  db: Database,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const result = await bindTenantUserQuery(orgId, db, tenantId, userId);
  return result.length > 0;
}

export function markInviteAcceptedQuery(orgId: string, db: Database, inviteId: string, acceptedUserId: string) {
  return db
    .update(tenantInvite)
    .set({ acceptedAt: new Date(), acceptedUserId })
    .where(and(eq(tenantInvite.orgId, orgId), eq(tenantInvite.id, inviteId), isNull(tenantInvite.acceptedAt)));
}

export async function markInviteAccepted(
  orgId: string,
  db: Database,
  inviteId: string,
  acceptedUserId: string,
): Promise<void> {
  await markInviteAcceptedQuery(orgId, db, inviteId, acceptedUserId);
}

export function revokePortalAccessQuery(orgId: string, db: Database, tenantId: string) {
  return db
    .update(tenant)
    .set({ userId: null, updatedAt: new Date() })
    .where(and(eq(tenant.orgId, orgId), eq(tenant.id, tenantId), isNull(tenant.deletedAt)))
    .returning({ id: tenant.id });
}

/** The move-out kill switch: unbinds the login and revokes any outstanding invite.
 *  Takes effect on the tenant's very next request, because `requireTenant`
 *  re-resolves scope from the database every time — no session to invalidate. */
export async function revokePortalAccess(orgId: string, db: Database, tenantId: string): Promise<boolean> {
  const result = await revokePortalAccessQuery(orgId, db, tenantId);
  if (result.length === 0) return false;
  await revokeLiveInvites(orgId, db, tenantId);
  return true;
}
