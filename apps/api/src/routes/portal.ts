import { Hono } from 'hono';
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
import { markEmailVerified } from '../db/repo/auth/user.js';
import { findInviteByTokenHash, findUserByEmail } from '../db/repo/public/invite.js';
import * as tenantRepo from '../db/repo/tenant.js';
import * as profileRepo from '../db/repo/portal/profile.js';
import type { AppBindings } from '../types.js';

export const portal = new Hono<AppBindings>();

/**
 * Accepting an invite is reachable by anyone — no `requireAuth`/`requireTenant` on
 * this route. The token itself, hashed and matched against `tenant_invite.token_hash`,
 * is the only authorization check. See db/repo/public/invite.ts.
 *
 * Registered BEFORE `portal.use('/v1/portal/*', requireTenant)` below, on purpose:
 * Hono composes matched handlers in registration order, and this route's own handler
 * never calls `next()`, so a request that matches it is answered without the
 * wildcard middleware ever running. Moving this registration below the `.use()`
 * would make it 401 for a user with no session — which must never happen for the
 * one route every unauthenticated tenant has to be able to reach.
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
  await markEmailVerified(db, newUserId);

  // Same CAS check as the signed-in branch above: if this loses — a concurrent
  // accept already bound the tenant between the pre-check above and here — a
  // freshly created, emailVerified account must NOT be left orphaned at 200 with a
  // tenant it is not attached to. That account is otherwise unrecoverable: the
  // invite is gone (reusing the link 404s) and signing in and retrying 409s on the
  // tenantUserId check, with no path back to the tenant it was created for.
  const bound = await tenantRepo.bindTenantUser(invite.orgId, db, invite.tenantId, newUserId);
  if (!bound) throw conflict('This tenant already has portal access.');

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

// Closed by default: every OTHER path under /v1/portal/* requires a resolved tenant
// scope, including ones that do not exist yet. This is the fix for the fail-open
// bug a path-specific `.use()` had: that matched exactly one route and nothing
// else, so every portal route added from here on (leases, charges, documents, …)
// would have been unauthenticated until someone remembered to list it too — the
// exact failure mode docs/PLAN-V1.md §1.1 rejects the tenant-as-org-member model
// for. Registered AFTER the public accept route above, so that one route is still
// reachable before this applies (see its own comment).
portal.use('/v1/portal/*', requireTenant);

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
