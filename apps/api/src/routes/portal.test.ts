import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings, TenantScope } from '../types.js';

/**
 * Route-level tests for the public invite-accept endpoint and the tenant profile
 * endpoints — the two places docs/PLAN-V1.md §1.6's attack table bites hardest in
 * Phase 1.
 */

const TENANT_A1 = '00000000-0000-7000-8000-00000000a001';
const OTHER_TENANT = '00000000-0000-7000-8000-00000000a002';

const getSessionMock = vi.fn();
const signUpEmailMock = vi.fn();
vi.mock('../lib/auth.js', () => ({
  getSession: getSessionMock,
  createAuth: () => ({ api: { signUpEmail: signUpEmailMock } }),
}));

const inviteRepoMock = { findInviteByTokenHash: vi.fn(), findUserByEmail: vi.fn() };
vi.mock('../db/repo/public/invite.js', () => inviteRepoMock);

const tenantRepoMock = { bindTenantUser: vi.fn(), markInviteAccepted: vi.fn() };
vi.mock('../db/repo/tenant.js', () => tenantRepoMock);

const profileRepoMock = { getProfile: vi.fn(), updateProfile: vi.fn() };
vi.mock('../db/repo/portal/profile.js', () => profileRepoMock);

let currentScope: TenantScope = { userId: 'user_dana', pairs: [{ orgId: 'org_A', tenantId: TENANT_A1 }] };
vi.mock('../middleware/auth.js', () => ({
  requireTenant: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('tenantScope', currentScope);
    await next();
  },
}));

const { portal } = await import('./portal.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    } as never);
    await next();
  });
  app.route('/', portal);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };

function liveInvite(overrides: Partial<Record<string, unknown>> = {}) {
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24);
  return {
    inviteId: 'invite_1',
    orgId: 'org_A',
    orgName: 'Alice Lettings',
    tenantId: TENANT_A1,
    tenantFirstName: 'Dana',
    tenantLastName: 'Lee',
    tenantUserId: null,
    tenantDeletedAt: null,
    tenantStatus: 'active',
    email: 'dana@example.com',
    expiresAt: future,
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentScope = { userId: 'user_dana', pairs: [{ orgId: 'org_A', tenantId: TENANT_A1 }] };
});

const INVALID_INVITE_MESSAGE = 'This invitation is no longer valid. Ask your landlord to send a new one.';

describe('accept invite — identical 404 for every invalid state (docs/PLAN-V1.md §1.3)', () => {
  it('no invite matches the token hash at all', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(null);
    const res = await post('/v1/portal/invites/accept', { token: 'a'.repeat(64), account: { name: 'X', password: 'password123' } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INVALID_INVITE_MESSAGE);
  });

  it('expired', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite({ expiresAt: new Date(Date.now() - 1000) }));
    const res = await acceptAsNewAccount();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INVALID_INVITE_MESSAGE);
  });

  it('revoked', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite({ revokedAt: new Date() }));
    const res = await acceptAsNewAccount();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INVALID_INVITE_MESSAGE);
  });

  it('already accepted (reused token)', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite({ acceptedAt: new Date() }));
    const res = await acceptAsNewAccount();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INVALID_INVITE_MESSAGE);
  });

  it('tenant archived since the invite was issued', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite({ tenantStatus: 'archived' }));
    const res = await acceptAsNewAccount();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INVALID_INVITE_MESSAGE);
  });

  it('tenant soft-deleted since the invite was issued', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite({ tenantDeletedAt: new Date() }));
    const res = await acceptAsNewAccount();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(INVALID_INVITE_MESSAGE);
  });

  it('every one of the above produces the exact same message, word for word', async () => {
    const states = [
      liveInvite({ expiresAt: new Date(Date.now() - 1) }),
      liveInvite({ revokedAt: new Date() }),
      liveInvite({ acceptedAt: new Date() }),
      liveInvite({ tenantStatus: 'archived' }),
    ];
    const messages: string[] = [];
    for (const state of states) {
      inviteRepoMock.findInviteByTokenHash.mockResolvedValue(state);
      const res = await acceptAsNewAccount();
      messages.push(((await res.json()) as { error: { message: string } }).error.message);
    }
    expect(new Set(messages).size).toBe(1);
  });
});

describe('accept invite — signed out, creating a new account', () => {
  it('requires account.name and account.password when no session is present', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite());
    getSessionMock.mockResolvedValue(null);

    const res = await post('/v1/portal/invites/accept', { token: 'a'.repeat(64) });
    expect(res.status).toBe(422);
    expect(signUpEmailMock).not.toHaveBeenCalled();
  });

  it("creates the account with the invite's email, never one from the request body", async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite({ email: 'real@example.com' }));
    getSessionMock.mockResolvedValue(null);
    inviteRepoMock.findUserByEmail.mockResolvedValue(null);
    signUpEmailMock.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'new_user_1' } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    tenantRepoMock.bindTenantUser.mockResolvedValue(true);

    const res = await post('/v1/portal/invites/accept', {
      token: 'a'.repeat(64),
      // An attacker-controlled body trying to claim a different address — ignored.
      account: { name: 'Attacker', password: 'password123', email: 'attacker@evil.example' },
    });

    expect(res.status).toBe(200);
    expect(signUpEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ email: 'real@example.com' }) }),
    );
    expect(tenantRepoMock.bindTenantUser).toHaveBeenCalledWith('org_A', expect.anything(), TENANT_A1, 'new_user_1');
  });

  it('409s if an account already exists for the invite email', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite());
    getSessionMock.mockResolvedValue(null);
    inviteRepoMock.findUserByEmail.mockResolvedValue({ id: 'existing_user' });

    const res = await acceptAsNewAccount();
    expect(res.status).toBe(409);
    expect(signUpEmailMock).not.toHaveBeenCalled();
  });

  it('409s, not a false 200, when the bind loses a race after the account was already created', async () => {
    // Regression test for BLOCKING-2: a concurrent accept (signed-in path, or
    // another signed-out accept) bound the tenant between the pre-checks above and
    // here. The account Better Auth just created is real and emailVerified, but it
    // must never be reported as a success it is not — that is what made the bug a
    // PERMANENT lockout rather than an ordinary error: a 200 here gives the caller
    // no reason to do anything differently, while the tenant they wanted is bound
    // to someone else and the invite is spent.
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite());
    getSessionMock.mockResolvedValue(null);
    inviteRepoMock.findUserByEmail.mockResolvedValue(null);
    signUpEmailMock.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: 'new_user_1' } }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    tenantRepoMock.bindTenantUser.mockResolvedValue(false); // the CAS lost

    const res = await acceptAsNewAccount();

    expect(res.status).toBe(409);
    expect(tenantRepoMock.markInviteAccepted).not.toHaveBeenCalled();
    // No session cookie is handed out for a response that reports failure.
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('accept invite — signed in, binding the current user', () => {
  it('binds the current session user and ignores any account fields', async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite());
    getSessionMock.mockResolvedValue({ user: { id: 'user_dana' }, session: {} });
    tenantRepoMock.bindTenantUser.mockResolvedValue(true);

    const res = await post('/v1/portal/invites/accept', {
      token: 'a'.repeat(64),
      account: { name: 'Should be ignored', password: 'password123' },
    });

    expect(res.status).toBe(200);
    expect(tenantRepoMock.bindTenantUser).toHaveBeenCalledWith('org_A', expect.anything(), TENANT_A1, 'user_dana');
    expect(signUpEmailMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { accountCreated: boolean };
    expect(body.accountCreated).toBe(false);
  });

  it("409s if the tenant's userId is already bound to someone else", async () => {
    inviteRepoMock.findInviteByTokenHash.mockResolvedValue(liveInvite({ tenantUserId: 'someone_else' }));
    getSessionMock.mockResolvedValue({ user: { id: 'user_dana' }, session: {} });

    const res = await post('/v1/portal/invites/accept', { token: 'a'.repeat(64) });
    expect(res.status).toBe(409);
  });
});

describe('portal profile — tenant resolving another tenant record (docs/PLAN-V1.md §1.6)', () => {
  it("GET .../profile for a tenantId not in the caller's scope is 404, not 403", async () => {
    profileRepoMock.getProfile.mockResolvedValue(null); // the repo already enforces this; route just surfaces it

    const res = await buildApp().request(`/v1/portal/${OTHER_TENANT}/profile`, {}, testEnv);
    expect(res.status).toBe(404);
  });

  it("PATCH .../profile for a tenantId not in the caller's scope is 404, not 403", async () => {
    profileRepoMock.updateProfile.mockResolvedValue(null);

    const res = await buildApp().request(`/v1/portal/${OTHER_TENANT}/profile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '555-0100' }),
    }, testEnv);
    expect(res.status).toBe(404);
  });

  it('a successful profile response never carries a notes field', async () => {
    profileRepoMock.getProfile.mockResolvedValue({
      tenantId: TENANT_A1,
      orgId: 'org_A',
      orgName: 'Alice Lettings',
      firstName: 'Dana',
      lastName: 'Lee',
      email: 'dana@example.com',
      phone: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      remindersOptedOut: false,
    });

    const res = await buildApp().request(`/v1/portal/${TENANT_A1}/profile`, {}, testEnv);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.notes).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/notes/i);
  });
});

async function post(path: string, json: unknown) {
  return buildApp().request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) },
    testEnv,
  );
}

async function acceptAsNewAccount() {
  return post('/v1/portal/invites/accept', {
    token: 'a'.repeat(64),
    account: { name: 'Dana Lee', password: 'password123' },
  });
}
