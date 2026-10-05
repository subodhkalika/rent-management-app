import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';

/**
 * Route-level tests for the landlord tenant endpoints.
 *
 * `requireAuth` is mocked to a trivial pass-through that sets `orgId`/`userId` from
 * whatever the test configures — its OWN correctness (the "tenant never reaches a
 * landlord route" guarantee) is proved separately in middleware/auth.test.ts. These
 * tests are about what happens once a landlord is already authenticated: in
 * particular, that landlord B holding landlord A's tenant UUID gets 404, never a
 * 403 that would confirm the row exists (docs/PLAN-V1.md §1.6).
 */

let currentOrgId = 'org_A';
let currentUserId = 'user_1';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('orgId', currentOrgId);
    c.set('userId', currentUserId);
    await next();
  },
}));

const tenantRepoMock = {
  listTenants: vi.fn(),
  createTenant: vi.fn(),
  getTenant: vi.fn(),
  updateTenant: vi.fn(),
  archiveTenant: vi.fn(),
  createInvite: vi.fn(),
  revokePortalAccess: vi.fn(),
};
vi.mock('../db/repo/tenant.js', () => tenantRepoMock);

const authOrgRepoMock = { getOrganizationName: vi.fn() };
vi.mock('../db/repo/auth/organization.js', () => authOrgRepoMock);

const { tenants } = await import('./tenants.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', tenants);
  // Mirrors index.ts's onError — a test app with no error handler returns Hono's
  // default plain-text 500 for a thrown ApiException instead of the real JSON error
  // body, which would make every error-path assertion below fail for the wrong
  // reason.
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };

function tenantRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '0191c2e4-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    firstName: 'Dana',
    lastName: 'Lee',
    email: 'dana@example.com',
    phone: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    notes: 'Private landlord note',
    status: 'active',
    remindersOptedOut: false,
    userId: null,
    portalEmail: null,
    latestInviteAcceptedAt: null,
    latestInviteRevokedAt: null,
    latestInviteExpiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  currentOrgId = 'org_A';
  currentUserId = 'user_1';
  vi.clearAllMocks();
  authOrgRepoMock.getOrganizationName.mockResolvedValue('Alice Lettings');
});

describe('landlord B holding landlord A tenant UUID (docs/PLAN-V1.md §1.6)', () => {
  it('GET /v1/tenants/:id returns 404, not 403, when the tenant belongs to another org', async () => {
    currentOrgId = 'org_B';
    tenantRepoMock.getTenant.mockResolvedValue(null); // getTenant's own orgId filter already excludes it

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-00000000000a', {}, testEnv);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    // The getTenant mock was called WITH org_B — proving the route trusted the
    // session's orgId, never anything from the path or body, to scope the lookup.
    expect(tenantRepoMock.getTenant).toHaveBeenCalledWith('org_B', expect.anything(), '00000000-0000-7000-8000-00000000000a');
  });

  it("POST /v1/tenants/:id/invite on another org's tenant is 404, not 403", async () => {
    currentOrgId = 'org_B';
    tenantRepoMock.getTenant.mockResolvedValue(null);

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-00000000000a/invite', { method: 'POST' }, testEnv);

    expect(res.status).toBe(404);
    expect(tenantRepoMock.createInvite).not.toHaveBeenCalled();
  });

  it("DELETE /v1/tenants/:id/portal-access on another org's tenant is 404", async () => {
    tenantRepoMock.revokePortalAccess.mockResolvedValue(false);

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-00000000000a/portal-access', { method: 'DELETE' }, testEnv);

    expect(res.status).toBe(404);
  });
});

describe('invite rules', () => {
  it('inviting a tenant with no email on file is 400, not a crash', async () => {
    tenantRepoMock.getTenant.mockResolvedValue(tenantRow({ email: null }));

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-000000000001/invite', { method: 'POST' }, testEnv);

    expect(res.status).toBe(400);
    expect(tenantRepoMock.createInvite).not.toHaveBeenCalled();
  });

  it('inviting a tenant who already has portal access is 409', async () => {
    tenantRepoMock.getTenant.mockResolvedValue(tenantRow({ userId: 'user_existing' }));

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-000000000001/invite', { method: 'POST' }, testEnv);

    expect(res.status).toBe(409);
    expect(tenantRepoMock.createInvite).not.toHaveBeenCalled();
  });

  it('a successful invite returns the url exactly once, built from WEB_ORIGIN, never a hardcoded host', async () => {
    tenantRepoMock.getTenant.mockResolvedValue(tenantRow());
    tenantRepoMock.createInvite.mockResolvedValue({ id: 'invite_1' });

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-000000000001/invite', { method: 'POST' }, testEnv);

    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string; email: string };
    expect(body.url.startsWith('https://app.example.com/portal/accept?token=')).toBe(true);
    expect(body.email).toBe('dana@example.com');
    expect(tenantRepoMock.createInvite).toHaveBeenCalledOnce();
  });
});

describe('response shape', () => {
  it('the landlord-facing tenant response includes notes (it is only banned from the PORTAL response)', async () => {
    tenantRepoMock.getTenant.mockResolvedValue(tenantRow());

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-000000000001', {}, testEnv);
    const body = (await res.json()) as { notes: string | null };
    expect(body.notes).toBe('Private landlord note');
  });

  it('never leaks internal columns (userId, latestInvite*) onto the wire', async () => {
    tenantRepoMock.getTenant.mockResolvedValue(tenantRow());

    const res = await buildApp().request('/v1/tenants/00000000-0000-7000-8000-000000000001', {}, testEnv);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.userId).toBeUndefined();
    expect(body.latestInviteAcceptedAt).toBeUndefined();
  });
});

describe('no portal route ever reads an orgId from the request', () => {
  it('ignores a forged ?orgId= query param — the route always uses the session value', async () => {
    tenantRepoMock.listTenants.mockResolvedValue({ rows: [], hasMore: false });

    await buildApp().request('/v1/tenants?orgId=org_B&limit=5', {}, testEnv);

    expect(tenantRepoMock.listTenants).toHaveBeenCalledWith('org_A', expect.anything(), expect.anything());
  });
});
