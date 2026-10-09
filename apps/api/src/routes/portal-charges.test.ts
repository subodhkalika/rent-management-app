import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings, TenantScope } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';
import type { ChargeRow } from '../db/repo/charge.js';

/**
 * Route-level tests for `GET /v1/portal/leases/:id/charges` — the §9.4 tenant
 * attack table, verify-then-scope shape.
 */

const TENANT_A1 = '00000000-0000-7000-8000-00000000a001'; // Dana, in org A
const LEASE_L1 = '00000000-0000-7000-8000-00000000c001'; // Dana's own lease
const LEASE_NEIGHBOUR = '00000000-0000-7000-8000-00000000c002'; // same org, Nina's lease

let currentScope: TenantScope = { userId: 'user_dana', pairs: [{ orgId: 'org_A', tenantId: TENANT_A1 }] };
vi.mock('../middleware/auth.js', () => ({
  requireTenant: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('tenantScope', currentScope);
    await next();
  },
}));

const portalLeaseRepoMock = { resolveLease: vi.fn() };
vi.mock('../db/repo/portal/lease.js', () => portalLeaseRepoMock);

const chargeRepoMock = { listCharges: vi.fn() };
vi.mock('../db/repo/charge.js', () => chargeRepoMock);

const { portalCharges } = await import('./portal-charges.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', portalCharges);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };

function chargeRow(overrides: Partial<ChargeRow> = {}): ChargeRow {
  return {
    id: '00000000-0000-7000-8000-00000000d001',
    leaseId: LEASE_L1,
    type: 'rent',
    generationKey: '2026-04-01',
    periodIndex: 0,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    occupiedStart: '2026-04-17',
    occupiedEnd: '2026-04-30',
    daysOccupied: 14,
    daysInPeriod: 30,
    dueDate: '2026-04-17',
    amountCents: 70000,
    isProrated: true,
    currency: 'USD',
    description: null,
    source: 'generated',
    supersedesChargeId: null,
    voidedAt: null,
    voidedReason: null,
    voidedByUserId: null,
    createdByUserId: null,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function get(path: string) {
  return buildApp().request(path, {}, testEnv);
}

beforeEach(() => {
  currentScope = { userId: 'user_dana', pairs: [{ orgId: 'org_A', tenantId: TENANT_A1 }] };
  vi.clearAllMocks();
});

describe('GET /v1/portal/leases/:id/charges', () => {
  it('resolveLease runs FIRST — 404s before any charge query when the lease does not resolve', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_L1}/charges`);
    expect(res.status).toBe(404);
    expect(chargeRepoMock.listCharges).not.toHaveBeenCalled();
  });

  it("the next-door-neighbour case: same org, different tenant — resolveLease returns null, never Nina's charges", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_NEIGHBOUR}/charges`);
    expect(res.status).toBe(404);
    expect(chargeRepoMock.listCharges).not.toHaveBeenCalled();
  });

  it("another org's lease id 404s the same way — existence is never confirmed", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/00000000-0000-7000-8000-00000000ffff/charges`);
    expect(res.status).toBe(404);
  });

  it("returns the caller's own charges, mapped through the portal shape — no voidedReason, no source, no generationKey", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue({ orgId: 'org_A', id: LEASE_L1 });
    chargeRepoMock.listCharges.mockResolvedValue({
      rows: [chargeRow({ voidedAt: new Date('2026-04-02T00:00:00.000Z'), voidedReason: 'Landlord error — unflattering note' })],
      hasMore: false,
    });

    const res = await get(`/v1/portal/leases/${LEASE_L1}/charges`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    const item = body.items[0];
    expect(item.isVoided).toBe(true);
    expect(item.voidedReason).toBeUndefined();
    expect(item.source).toBeUndefined();
    expect(item.generationKey).toBeUndefined();
    expect(item.periodIndex).toBeUndefined();
    // The disputed numbers ARE present.
    expect(item.daysOccupied).toBe(14);
    expect(item.daysInPeriod).toBe(30);
    expect(item.isProrated).toBe(true);

    // The orgId used for the charge query is the one `resolveLease` returned —
    // came out of a capability check, trusted exactly like a session orgId.
    expect(chargeRepoMock.listCharges).toHaveBeenCalledWith('org_A', expect.anything(), LEASE_L1, expect.anything());
  });

  it('a malformed lease id 404s before resolveLease ever runs', async () => {
    const res = await get('/v1/portal/leases/not-a-uuid/charges');
    expect(res.status).toBe(404);
    expect(portalLeaseRepoMock.resolveLease).not.toHaveBeenCalled();
  });

  it("a tenant with an empty scope (archived mid-session) never resolves anyone's lease", async () => {
    currentScope = { userId: 'user_dana', pairs: [] };
    portalLeaseRepoMock.resolveLease.mockImplementation(async (scope: TenantScope) =>
      scope.pairs.length === 0 ? null : { orgId: 'org_A', id: LEASE_L1 },
    );
    const res = await get(`/v1/portal/leases/${LEASE_L1}/charges`);
    expect(res.status).toBe(404);
  });
});
