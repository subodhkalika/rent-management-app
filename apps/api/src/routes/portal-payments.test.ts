import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings, TenantScope } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';
import type { PaymentRow } from '../db/repo/payment.js';

/**
 * Route-level tests for the tenant-facing payment/balance endpoints (PLAN-
 * PHASE3B.md §8.2, §9). `resolveLease` runs FIRST on both routes — the
 * verify-then-scope shape `portal-charges.test.ts` already established.
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

const portalBalanceRepoMock = { portalBalanceForLease: vi.fn() };
vi.mock('../db/repo/portal/balance.js', () => portalBalanceRepoMock);

const paymentRepoMock = { listPayments: vi.fn() };
vi.mock('../db/repo/payment.js', () => paymentRepoMock);

const { portalPayments } = await import('./portal-payments.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', portalPayments);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };

function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: '00000000-0000-7000-8000-00000000d001',
    leaseId: LEASE_L1,
    kind: 'payment',
    method: 'bank_transfer',
    amountCents: 100000,
    currency: 'USD',
    receivedOn: '2026-04-01',
    reference: 'REF123',
    note: 'Landlord-private note — never seen by a tenant',
    supersedesPaymentId: null,
    voidedAt: null,
    voidedReason: null,
    voidedByUserId: null,
    recordedByUserId: 'user_landlord',
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    updatedAt: new Date('2026-04-01T00:00:00.000Z'),
    ...overrides,
  };
}

function resolvedLease(overrides: Record<string, unknown> = {}) {
  return { orgId: 'org_A', id: LEASE_L1, chainId: LEASE_L1, currency: 'USD', propertyTimezone: 'UTC', ...overrides };
}

async function get(path: string) {
  return buildApp().request(path, {}, testEnv);
}

beforeEach(() => {
  currentScope = { userId: 'user_dana', pairs: [{ orgId: 'org_A', tenantId: TENANT_A1 }] };
  vi.clearAllMocks();
});

describe('GET /v1/portal/leases/:id/payments', () => {
  it('resolveLease runs FIRST — 404s before any payment query when the lease does not resolve', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_L1}/payments`);
    expect(res.status).toBe(404);
    expect(paymentRepoMock.listPayments).not.toHaveBeenCalled();
  });

  it("the next-door-neighbour case: same org, different tenant — resolveLease returns null, never Nina's payments", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_NEIGHBOUR}/payments`);
    expect(res.status).toBe(404);
    expect(paymentRepoMock.listPayments).not.toHaveBeenCalled();
  });

  it("returns the caller's own payments, mapped through the portal shape — no note, no voidedReason, no user ids", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(resolvedLease());
    paymentRepoMock.listPayments.mockResolvedValue({
      rows: [paymentRow({ voidedAt: new Date('2026-04-02T00:00:00.000Z'), voidedReason: 'Unflattering landlord note' })],
      hasMore: false,
    });

    const res = await get(`/v1/portal/leases/${LEASE_L1}/payments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    const item = body.items[0];
    expect(item.isVoided).toBe(true);
    expect(item.voidedReason).toBeUndefined();
    expect(item.note).toBeUndefined();
    expect(item.recordedByUserId).toBeUndefined();
    // The tenant's own bank reference IS present.
    expect(item.reference).toBe('REF123');

    expect(paymentRepoMock.listPayments).toHaveBeenCalledWith('org_A', expect.anything(), LEASE_L1, expect.anything());
  });

  it('a malformed lease id 404s before resolveLease ever runs', async () => {
    const res = await get('/v1/portal/leases/not-a-uuid/payments');
    expect(res.status).toBe(404);
    expect(portalLeaseRepoMock.resolveLease).not.toHaveBeenCalled();
  });

  it("a tenant with an empty scope (archived mid-session) never resolves anyone's lease", async () => {
    currentScope = { userId: 'user_dana', pairs: [] };
    portalLeaseRepoMock.resolveLease.mockImplementation(async (scope: TenantScope) =>
      scope.pairs.length === 0 ? null : resolvedLease(),
    );
    const res = await get(`/v1/portal/leases/${LEASE_L1}/payments`);
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/portal/leases/:id/balance', () => {
  it('resolveLease runs FIRST — 404s before any balance computation when the lease does not resolve', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_L1}/balance`);
    expect(res.status).toBe(404);
    expect(portalBalanceRepoMock.portalBalanceForLease).not.toHaveBeenCalled();
  });

  it("the next-door-neighbour case: same org, different tenant — 404s, never Nina's balance", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_NEIGHBOUR}/balance`);
    expect(res.status).toBe(404);
  });

  it('returns the unsigned, bucketed shape — no signed balanceCents field at all', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(resolvedLease());
    portalBalanceRepoMock.portalBalanceForLease.mockResolvedValue({
      leaseId: LEASE_L1,
      currency: 'USD',
      asOfDate: '2026-04-10',
      outstandingCents: 0,
      overdueCents: 0,
      depositOutstandingCents: 0,
      creditCents: 50000,
      nextDueDate: null,
      nextDueAmountCents: 0,
    });

    const res = await get(`/v1/portal/leases/${LEASE_L1}/balance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.creditCents).toBe(50000);
    expect(body).not.toHaveProperty('balanceCents');
  });

  it('a malformed lease id 404s before resolveLease ever runs', async () => {
    const res = await get('/v1/portal/leases/not-a-uuid/balance');
    expect(res.status).toBe(404);
    expect(portalLeaseRepoMock.resolveLease).not.toHaveBeenCalled();
  });
});

/* ======================================================================== *
 * §9's landlord-write-paths-403 half is covered by auth-layer's own tests —
 * a tenant never reaches `requireAuth`'s landlord routes at all. Named here
 * so the omission reads as a decision: there is no portal route that accepts
 * a bare payment id (§9's own table), so no further guard is needed here.
 * ======================================================================== */
