import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings } from '../types.js';

/**
 * Proves the fix for BLOCKING-1: `portal.ts` used to register
 * `portal.use('/v1/portal/:tenantId/profile', requireTenant)`, which matched one
 * exact path and nothing else. Every portal route added from here on would have
 * been unauthenticated by default until someone remembered to list it too — the
 * precise "security boundary that defaults to open" docs/PLAN-V1.md §1.1 rejects
 * the tenant-as-org-member model for in the first place.
 *
 * Unlike portal.test.ts, this file does NOT mock `middleware/auth.js` — it exercises
 * the REAL `requireTenant`, so a route that does not exist yet still has to go
 * through it. Only `getSession` and `resolveScope` (its two real dependencies) are
 * mocked.
 */

const getSessionMock = vi.fn();
vi.mock('../lib/auth.js', () => ({
  getSession: getSessionMock,
  createAuth: vi.fn(),
}));

const resolveScopeMock = vi.fn();
vi.mock('../db/repo/portal/scope.js', () => ({ resolveScope: resolveScopeMock }));

// Only needed so the last test below (the public accept route) doesn't hit a real
// query against the empty fake `db` — irrelevant to what that test is proving.
vi.mock('../db/repo/public/invite.js', () => ({
  findInviteByTokenHash: vi.fn().mockResolvedValue(null),
  findUserByEmail: vi.fn(),
}));

const { portal } = await import('./portal.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.route('/', portal);
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404));
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };

beforeEach(() => {
  getSessionMock.mockReset();
  resolveScopeMock.mockReset();
});

describe('every /v1/portal/* path is closed by default', () => {
  it('a route that does not exist yet is 401 (unauthenticated), never 404, when there is no session', async () => {
    getSessionMock.mockResolvedValue(null);

    // This path is not registered anywhere in portal.ts — it stands in for ANY
    // route a future phase adds (leases, charges, documents, …) before its handler
    // is written. If this ever becomes 404, the wildcard guard has regressed to
    // fail-open.
    const res = await buildApp().request('/v1/portal/leases', {}, testEnv);

    expect(res.status).toBe(401);
    expect(resolveScopeMock).not.toHaveBeenCalled();
  });

  it('a nonexistent route is 403 (no tenant scope), not 404, for a signed-in non-tenant', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'user_1' }, session: {} });
    resolveScopeMock.mockResolvedValue([]); // signed in, but not a tenant anywhere

    const res = await buildApp().request('/v1/portal/documents/some-id', {}, testEnv);

    expect(res.status).toBe(403);
  });

  it('only once authenticated AND scoped does an unregistered path fall through to a real 404', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'user_1' }, session: {} });
    resolveScopeMock.mockResolvedValue([{ orgId: 'org_A', orgName: 'Alice Lettings', tenantId: 'tenant_1' }]);

    const res = await buildApp().request('/v1/portal/this-route-does-not-exist', {}, testEnv);

    expect(res.status).toBe(404);
  });

  it('the public accept-invite route is still reachable with NO session at all', async () => {
    getSessionMock.mockResolvedValue(null);

    const res = await buildApp().request(
      '/v1/portal/invites/accept',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'a'.repeat(64) }) },
      testEnv,
    );

    // The token doesn't resolve to anything (mocked above), so this is the ordinary
    // "invalid invite" 404 — what matters for THIS test is that it is NOT 401. 401
    // would mean the wildcard `requireTenant` ran ahead of the public route,
    // exactly the ordering bug this file exists to catch.
    expect(res.status).toBe(404);
    expect(getSessionMock).not.toHaveBeenCalled();
  });
});
