import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests `requireAuth` / `requireSession` / `requireTenant` as plain middleware
 * functions — no live DB, no live Better Auth instance. `getSession` and
 * `resolveScope` are mocked so these tests isolate exactly the ordering guarantee
 * that matters for docs/PLAN-V1.md §1.6's attack table: a tenant (no `member` row,
 * therefore no `activeOrganizationId`) must be rejected BEFORE any database query
 * runs, not merely rejected eventually.
 */

const getSessionMock = vi.fn();
vi.mock('../lib/auth.js', () => ({ getSession: getSessionMock }));

const resolveScopeMock = vi.fn();
vi.mock('../db/repo/portal/scope.js', () => ({ resolveScope: resolveScopeMock }));

const { requireAuth, requireSession, requireTenant } = await import('./auth.js');

/** A `db` whose every method throws — if a test passes only because this was never
 *  called, that is the point. If it IS called, the test fails loudly instead of
 *  silently returning undefined. */
function poisonedDb() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('db was queried — this code path must reject before touching the database');
      },
    },
  );
}

function fakeContext(overrides: { db?: unknown } = {}) {
  const store = new Map<string, unknown>();
  if (overrides.db !== undefined) store.set('db', overrides.db);
  return {
    req: { raw: new Request('https://api.example.com/v1/properties') },
    env: {},
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
  } as never;
}

beforeEach(() => {
  getSessionMock.mockReset();
  resolveScopeMock.mockReset();
});

describe('requireAuth — attack table row 1/2: tenant hitting a landlord route', () => {
  it('a signed-in user with no active organization is rejected BEFORE any db query', async () => {
    // This is exactly a tenant's session shape: Better Auth issues them a session
    // (requireSession would pass), but they have no `member` row anywhere, so
    // `activeOrganizationId` is never set — see docs/PLAN-V1.md §1.1.
    getSessionMock.mockResolvedValue({ user: { id: 'user_tenant' }, session: { activeOrganizationId: null } });

    const c = fakeContext({ db: poisonedDb() });
    const next = vi.fn();

    await expect(requireAuth(c, next)).rejects.toMatchObject({ code: 'forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('no session at all is 401, also before any db query', async () => {
    getSessionMock.mockResolvedValue(null);
    const c = fakeContext({ db: poisonedDb() });

    await expect(requireAuth(c, vi.fn())).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('requireTenant — attack table row: archived mid-session is 403 on the very next request', () => {
  it('zero live tenant rows is 403 forbidden', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'user_1' }, session: {} });
    resolveScopeMock.mockResolvedValue([]); // archived, soft-deleted, or never a tenant

    const c = fakeContext({ db: {} });
    await expect(requireTenant(c, vi.fn())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('re-resolves scope from the database on every call — never caches', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'user_1' }, session: {} });

    resolveScopeMock.mockResolvedValueOnce([{ orgId: 'org_A', orgName: 'Alice Lettings', tenantId: 'tenant_1' }]);
    const c1 = fakeContext({ db: {} });
    await requireTenant(c1, vi.fn());
    expect((c1 as unknown as { get: (k: string) => unknown }).get('tenantScope')).toEqual({
      userId: 'user_1',
      pairs: [{ orgId: 'org_A', tenantId: 'tenant_1' }],
    });

    // Landlord archives the tenant between requests — the NEXT call resolves empty
    // and rejects, with no session state anywhere remembering the earlier success.
    resolveScopeMock.mockResolvedValueOnce([]);
    const c2 = fakeContext({ db: {} });
    await expect(requireTenant(c2, vi.fn())).rejects.toMatchObject({ code: 'forbidden' });

    expect(resolveScopeMock).toHaveBeenCalledTimes(2);
  });

  it('a user with multiple live tenancies gets every (orgId, tenantId) pair, across orgs', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'user_dana' }, session: {} });
    resolveScopeMock.mockResolvedValue([
      { orgId: 'org_A', orgName: 'Alice Lettings', tenantId: 'tenant_A1' },
      { orgId: 'org_B', orgName: 'Bob Property', tenantId: 'tenant_B1' },
    ]);

    const c = fakeContext({ db: {} });
    const next = vi.fn();
    await requireTenant(c, next);

    expect(next).toHaveBeenCalledOnce();
    expect((c as unknown as { get: (k: string) => unknown }).get('tenantScope')).toEqual({
      userId: 'user_dana',
      pairs: [
        { orgId: 'org_A', tenantId: 'tenant_A1' },
        { orgId: 'org_B', tenantId: 'tenant_B1' },
      ],
    });
  });
});

describe('requireSession', () => {
  it('rejects with 401 when there is no session', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(requireSession(fakeContext(), vi.fn())).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('sets userId and calls next when a session exists — makes no judgement about org or tenancy', async () => {
    getSessionMock.mockResolvedValue({ user: { id: 'user_1' }, session: {} });
    const c = fakeContext();
    const next = vi.fn();
    await requireSession(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect((c as unknown as { get: (k: string) => unknown }).get('userId')).toBe('user_1');
  });
});
