import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import {
  acceptInviteBody,
  updatePortalProfileBody,
  type AcceptInviteBody,
  type UpdatePortalProfileBody,
  type InviteAccepted,
} from '@rms/contract';
import { requireTenant } from '../middleware/auth.js';
import { validateBody, parsedBody } from '../middleware/validate.js';
import { conflict, notFound, validationFailed, inviteInvalid } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { sha256Hex } from '../lib/tokens.js';
import { mapPortalProfile } from '../lib/mappers.js';
import { getSession, createAuth } from '../lib/auth.js';
import { user as userTable } from '../db/schema.js';
import { findInviteByTokenHash, findUserByEmail } from '../db/repo/public/invite.js';
import * as tenantRepo from '../db/repo/tenant.js';
import * as profileRepo from '../db/repo/portal/profile.js';
import type { AppBindings } from '../types.js';

export const portal = new Hono<AppBindings>();

/**
 * Accepting an invite is reachable by anyone — no `requireAuth`/`requireTenant` on
 * this route. The token itself, hashed and matched against `tenant_invite.token_hash`,
 * is the only authorization check. See db/repo/public/invite.ts.
 */
portal.post('/v1/portal/invites/accept', validateBody(acceptInviteBody), async (c) => {
  const db = c.get('db');
  const body = parsedBody<AcceptInviteBody>(c);

  const tokenHash = await sha256Hex(body.token);
  const invite = await findInviteByTokenHash(db, tokenHash);

  // Every failure mode funnels through the exact same 404 — bad token, expired,
  // revoked, already accepted, tenant archived. The sameness IS the security
  // property: differentiating any of these would tell a brute-forcer which guess
  // was "closer". Do not split this into branches with more specific messages.
  if (!invite) throw inviteInvalid();

  const now = new Date();
  const isLive =
    invite.revokedAt === null &&
    invite.acceptedAt === null &&
    invite.expiresAt > now &&
    invite.tenantDeletedAt === null &&
    invite.tenantStatus !== 'archived';
  if (!isLive) throw inviteInvalid();

  // A defensive check, not the expected path: an invite this function found "live"
  // should never also have a bound tenant.userId (binding and marking accepted
  // happen together below). If it ever does — e.g. a future manual-bind tool —
  // refuse rather than silently rebind someone else's login.
  if (invite.tenantUserId) {
    throw conflict('This tenant already has portal access.');
  }

  const session = await getSession(c.req.raw, c.env);

  if (session?.user) {
    // Signed in: bind the CURRENT session user. Ignore any `account` fields in the
    // body entirely — this is how one person attaches a second landlord to an
    // existing login, never a way to overwrite who they are.
    const bound = await tenantRepo.bindTenantUser(invite.orgId, db, invite.tenantId, session.user.id);
    if (!bound) throw conflict('This tenant already has portal access.');

    await tenantRepo.markInviteAccepted(invite.orgId, db, invite.inviteId, session.user.id);

    const response: InviteAccepted = {
      tenantId: invite.tenantId,
      organizationName: invite.orgName,
      accountCreated: false,
    };
    return c.json(response);
  }

  // Signed out: `account` is required, and the account is created with the email
  // recorded ON THE INVITE — never one from the request body. That is what stops
  // the holder of a token from claiming an arbitrary address.
  if (!body.account) {
    throw validationFailed({ account: ['Name and password are required to create your account'] });
  }

  const existingUser = await findUserByEmail(db, invite.email);
  if (existingUser) {
    throw conflict('An account already exists for this email. Sign in first, then open the invite link again.');
  }

  const auth = createAuth(c.env);
  const signUpResponse = await auth.api.signUpEmail({
    body: { email: invite.email, name: body.account.name, password: body.account.password },
    asResponse: true,
  });

  if (!signUpResponse.ok) {
    // Translated to the same 409 a client would get from the pre-check above —
    // this only fires on a race (two accepts for the same email landing
    // concurrently), not on the ordinary path.
    throw conflict('An account already exists for this email. Sign in first, then open the invite link again.');
  }

  const signUpBody = (await signUpResponse.json()) as { user: { id: string } };
  const newUserId = signUpBody.user.id;

  // Possession of the emailed token proves the address — mark it verified rather
  // than making the tenant click a second email just to confirm what the invite
  // flow already confirmed.
  await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, newUserId));

  await tenantRepo.bindTenantUser(invite.orgId, db, invite.tenantId, newUserId);
  await tenantRepo.markInviteAccepted(invite.orgId, db, invite.inviteId, newUserId);

  const response: InviteAccepted = {
    tenantId: invite.tenantId,
    organizationName: invite.orgName,
    accountCreated: true,
  };
  const res = c.json(response, 200);
  // Forward the session cookie Better Auth just set, so the tenant is signed in
  // immediately after accepting, without a second round trip to sign in.
  for (const cookie of signUpResponse.headers.getSetCookie?.() ?? []) {
    res.headers.append('set-cookie', cookie);
  }
  return res;
});

portal.use('/v1/portal/:tenantId/profile', requireTenant);

portal.get('/v1/portal/:tenantId/profile', async (c) => {
  const scope = c.get('tenantScope');
  const db = c.get('db');
  const tenantId = requireUuidParam(c.req.param('tenantId'), 'Tenant');

  const row = await profileRepo.getProfile(scope, db, tenantId);
  if (!row) throw notFound('Tenant');
  return c.json(mapPortalProfile(row));
});

portal.patch('/v1/portal/:tenantId/profile', validateBody(updatePortalProfileBody), async (c) => {
  const scope = c.get('tenantScope');
  const db = c.get('db');
  const tenantId = requireUuidParam(c.req.param('tenantId'), 'Tenant');
  const body = parsedBody<UpdatePortalProfileBody>(c);

  const row = await profileRepo.updateProfile(scope, db, tenantId, body);
  if (!row) throw notFound('Tenant');
  return c.json(mapPortalProfile(row));
});
