import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';
import type { LeaseRow } from '../db/repo/lease.js';

/**
 * Route-level tests for `/ledger`, `/balance`, `/arrears` (PLAN-PHASE3B.md
 * §8.1). `requireAuth` is mocked to a trivial pass-through, same shape as
 * `routes/charges.test.ts`.
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

const ledgerRepoMock = {
  leaseLedger: vi.fn(),
  leaseAndChainBalance: vi.fn(),
  orgArrears: vi.fn(),
};
vi.mock('../db/repo/ledger.js', () => ledgerRepoMock);

const leaseRepoMock = { getLease: vi.fn() };
vi.mock('../db/repo/lease.js', () => leaseRepoMock);

const { ledger } = await import('./ledger.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', ledger);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };
const LEASE_ID = '00000000-0000-7000-8000-00000000b001';
const CHAIN_ID = '00000000-0000-7000-8000-00000000b000';

function leaseRow(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    id: LEASE_ID,
    chainId: CHAIN_ID,
    status: 'active',
    unitId: '00000000-0000-7000-8000-00000000b010',
    unitLabel: '2B',
    propertyId: '00000000-0000-7000-8000-00000000b020',
    propertyName: 'Maple Court',
    propertyTimezone: 'America/Chicago',
    calendar: 'gregorian',
    moveOutBillingPolicy: 'bill_full_term',
    startDate: '2026-01-01',
    endDate: null,
    moveOutDate: null,
    rentCents: 150000,
    currency: 'USD',
    rentFrequency: 'monthly',
    billingDay: 1,
    depositCents: 0,
    openingBalanceCents: 0,
    ledgerStartDate: '2026-01-01',
    escalationMode: 'none',
    escalationRateBps: null,
    escalationIntervalYears: null,
    escalationCompounding: null,
    tenantCount: 1,
    primaryTenantName: 'Dana Lee',
    renewedFromLeaseId: null,
    endReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function chainBalance() {
  return {
    chainId: CHAIN_ID,
    currency: 'USD',
    chargedCents: 100000,
    paidCents: 100000,
    outstandingCents: 0,
    creditCents: 0,
    balanceCents: 0,
    arrearsCents: 0,
    depositOutstandingCents: 0,
    rentOutstandingCents: 0,
    oldestOverdueDueDate: null,
  };
}

beforeEach(() => {
  currentOrgId = 'org_A';
  currentUserId = 'user_1';
  vi.clearAllMocks();
});

async function get(path: string) {
  return buildApp().request(path, {}, testEnv);
}

describe('GET /v1/leases/:id/ledger', () => {
  it('404s when the lease does not exist', async () => {
    leaseRepoMock.getLease.mockResolvedValue(null);
    const res = await get(`/v1/leases/${LEASE_ID}/ledger`);
    expect(res.status).toBe(404);
  });

  it('404s when the repo finds no such chain (should not happen given a resolved lease, but defends the contract)', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow());
    ledgerRepoMock.leaseLedger.mockResolvedValue(null);
    const res = await get(`/v1/leases/${LEASE_ID}/ledger`);
    expect(res.status).toBe(404);
  });

  it('returns the whole chain, mapped, with truncated=false when under the cap', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow());
    ledgerRepoMock.leaseLedger.mockResolvedValue({
      chainId: CHAIN_ID,
      currency: 'USD',
      asOfDate: '2026-04-10',
      leases: [{ leaseId: LEASE_ID, startDate: '2026-01-01', endDate: null, isCurrent: true }],
      entries: [],
      balance: chainBalance(),
    });
    const res = await get(`/v1/leases/${LEASE_ID}/ledger`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.chainId).toBe(CHAIN_ID);
    expect(body.truncated).toBe(false);
    expect(body.leases).toHaveLength(1);
  });
});

describe('GET /v1/leases/:id/balance', () => {
  it('404s when the lease does not exist', async () => {
    leaseRepoMock.getLease.mockResolvedValue(null);
    const res = await get(`/v1/leases/${LEASE_ID}/balance`);
    expect(res.status).toBe(404);
  });

  it('returns both slices in one response', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow());
    ledgerRepoMock.leaseAndChainBalance.mockResolvedValue({
      lease: {
        leaseId: LEASE_ID,
        outstandingCents: 0,
        arrearsCents: 0,
        depositOutstandingCents: 0,
        rentOutstandingCents: 0,
      },
      chain: chainBalance(),
    });
    const res = await get(`/v1/leases/${LEASE_ID}/balance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.lease.leaseId).toBe(LEASE_ID);
    expect(body.chain.chainId).toBe(CHAIN_ID);
  });
});

describe('GET /v1/arrears', () => {
  it('returns groups, grouped by currency, never a flat list', async () => {
    ledgerRepoMock.orgArrears.mockResolvedValue({
      rows: [
        {
          chainId: CHAIN_ID,
          leaseId: LEASE_ID,
          currency: 'USD',
          propertyId: '00000000-0000-7000-8000-00000000b020',
          propertyName: 'Maple Court',
          unitId: '00000000-0000-7000-8000-00000000b010',
          unitLabel: '2B',
          primaryTenantName: 'Dana Lee',
          arrearsCents: 50000,
          oldestOverdueDueDate: '2026-03-01',
          daysLate: 40,
          isCurrent: true,
        },
      ],
      truncated: false,
    });
    const res = await get('/v1/arrears');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].currency).toBe('USD');
    expect(body.groups[0].totalArrearsCents).toBe(50000);
    expect(body.groups[0].rows).toHaveLength(1);
  });

  it('400s on an invalid minCents', async () => {
    const res = await get('/v1/arrears?minCents=not-a-number');
    expect(res.status).toBe(422);
  });

  it('empty is a real state — no chains in arrears', async () => {
    ledgerRepoMock.orgArrears.mockResolvedValue({ rows: [], truncated: false });
    const res = await get('/v1/arrears');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.groups).toEqual([]);
    expect(body.truncated).toBe(false);
  });
});

/* ======================================================================== *
 * §9 landlord-vs-landlord
 * ======================================================================== */

describe('§9 landlord-vs-landlord', () => {
  it("landlord B's GET of landlord A's lease ledger 404s via getLease's own org filter", async () => {
    currentOrgId = 'org_B';
    leaseRepoMock.getLease.mockResolvedValue(null);
    const res = await get(`/v1/leases/${LEASE_ID}/ledger`);
    expect(res.status).toBe(404);
    expect(ledgerRepoMock.leaseLedger).not.toHaveBeenCalled();
  });

  it("landlord B's GET of landlord A's lease balance 404s via getLease's own org filter", async () => {
    currentOrgId = 'org_B';
    leaseRepoMock.getLease.mockResolvedValue(null);
    const res = await get(`/v1/leases/${LEASE_ID}/balance`);
    expect(res.status).toBe(404);
    expect(ledgerRepoMock.leaseAndChainBalance).not.toHaveBeenCalled();
  });

  it("landlord B's GET /v1/arrears never reaches into landlord A's org — the repo call itself is org-B-scoped", async () => {
    currentOrgId = 'org_B';
    ledgerRepoMock.orgArrears.mockResolvedValue({ rows: [], truncated: false });
    const res = await get('/v1/arrears');
    expect(res.status).toBe(200);
    expect(ledgerRepoMock.orgArrears).toHaveBeenCalledWith('org_B', expect.anything(), expect.anything());
  });
});
