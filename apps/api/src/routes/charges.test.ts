import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException, conflict, notFound } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';
import type { LeaseRow } from '../db/repo/lease.js';
import type { ChargeRow, ChargeWithLeaseRow } from '../db/repo/charge.js';

/**
 * Route-level tests for the landlord charge endpoints (PLAN-PHASE3A.md §9.1).
 * `requireAuth` is mocked to a trivial pass-through, same shape as
 * `routes/leases.test.ts` — these tests are about what the ROUTE does once a
 * landlord is already authenticated, including the §9.4 landlord-vs-landlord half
 * of the attack table.
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

const chargeRepoMock = {
  listCharges: vi.fn(),
  listChargesForOrg: vi.fn(),
  createManualCharge: vi.fn(),
  voidCharge: vi.fn(),
  correctCharge: vi.fn(),
  generateChargesForLease: vi.fn(),
};
vi.mock('../db/repo/charge.js', () => chargeRepoMock);

const leaseRepoMock = {
  getLease: vi.fn(),
  listRentSteps: vi.fn(),
  toRentSteps: (rows: readonly { effectiveFrom: string; rentCents: number }[]) =>
    rows.map((r) => ({ effectiveFrom: r.effectiveFrom, rentCents: r.rentCents })),
};
vi.mock('../db/repo/lease.js', () => leaseRepoMock);

const { charges } = await import('./charges.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', charges);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };
const LEASE_ID = '00000000-0000-7000-8000-00000000b001';
const CHARGE_ID = '00000000-0000-7000-8000-00000000c001';

function leaseRow(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    id: LEASE_ID,
    chainId: LEASE_ID,
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

function chargeRow(overrides: Partial<ChargeRow> = {}): ChargeRow {
  return {
    id: CHARGE_ID,
    leaseId: LEASE_ID,
    type: 'rent',
    generationKey: '2026-04-01',
    periodIndex: 0,
    periodStart: '2026-04-01',
    periodEnd: '2026-04-30',
    occupiedStart: '2026-04-01',
    occupiedEnd: '2026-04-30',
    daysOccupied: 30,
    daysInPeriod: 30,
    dueDate: '2026-04-01',
    amountCents: 150000,
    isProrated: false,
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

function chargeWithLeaseRow(overrides: Partial<ChargeWithLeaseRow> = {}): ChargeWithLeaseRow {
  return {
    ...chargeRow(),
    propertyId: '00000000-0000-7000-8000-00000000b020',
    propertyName: 'Maple Court',
    unitId: '00000000-0000-7000-8000-00000000b010',
    unitLabel: '2B',
    propertyTimezone: 'America/Chicago',
    ...overrides,
  };
}

beforeEach(() => {
  currentOrgId = 'org_A';
  currentUserId = 'user_1';
  vi.clearAllMocks();
  leaseRepoMock.listRentSteps.mockResolvedValue([]);
});

async function post(path: string, json?: unknown) {
  return buildApp().request(
    path,
    json === undefined
      ? { method: 'POST' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) },
    testEnv,
  );
}

async function get(path: string) {
  return buildApp().request(path, {}, testEnv);
}

describe('GET /v1/leases/:id/charges', () => {
  it('404s when the lease does not exist (or is not this org\'s)', async () => {
    leaseRepoMock.getLease.mockResolvedValue(null);
    const res = await get(`/v1/leases/${LEASE_ID}/charges`);
    expect(res.status).toBe(404);
  });

  it('returns mapped items in order, with no nextCursor when there is no more', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow());
    chargeRepoMock.listCharges.mockResolvedValue({ rows: [chargeRow()], hasMore: false });

    const res = await get(`/v1/leases/${LEASE_ID}/charges`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(CHARGE_ID);
    expect(body.nextCursor).toBeNull();
  });

  it('a malformed lease id 404s before any query runs', async () => {
    const res = await get('/v1/leases/not-a-uuid/charges');
    expect(res.status).toBe(404);
    expect(leaseRepoMock.getLease).not.toHaveBeenCalled();
  });
});

describe('POST /v1/leases/:id/charges — manual charges', () => {
  it('creates a manual charge and returns 201', async () => {
    chargeRepoMock.createManualCharge.mockResolvedValue(chargeRow({ type: 'late_fee', source: 'manual', generationKey: null }));
    const res = await post(`/v1/leases/${LEASE_ID}/charges`, {
      type: 'late_fee',
      amountCents: 5000,
      dueDate: '2026-04-15',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.source).toBe('manual');
  });

  it('404s when the repo reports no such lease', async () => {
    chargeRepoMock.createManualCharge.mockResolvedValue(null);
    const res = await post(`/v1/leases/${LEASE_ID}/charges`, {
      type: 'late_fee',
      amountCents: 5000,
      dueDate: '2026-04-15',
    });
    expect(res.status).toBe(404);
  });

  it('409s when the repo refuses a draft/cancelled lease', async () => {
    chargeRepoMock.createManualCharge.mockRejectedValue(conflict('Charges cannot be added to a draft or cancelled lease.'));
    const res = await post(`/v1/leases/${LEASE_ID}/charges`, {
      type: 'late_fee',
      amountCents: 5000,
      dueDate: '2026-04-15',
    });
    expect(res.status).toBe(409);
  });

  it('422s on a manual `rent` charge — rejected at the schema boundary, never reaching the repo', async () => {
    const res = await post(`/v1/leases/${LEASE_ID}/charges`, {
      type: 'rent',
      amountCents: 5000,
      dueDate: '2026-04-15',
    });
    expect(res.status).toBe(422);
    expect(chargeRepoMock.createManualCharge).not.toHaveBeenCalled();
  });

  it('422s on a negative amountCents', async () => {
    const res = await post(`/v1/leases/${LEASE_ID}/charges`, {
      type: 'late_fee',
      amountCents: -100,
      dueDate: '2026-04-15',
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /v1/leases/:id/charges/generate', () => {
  it('404s when the lease does not exist', async () => {
    leaseRepoMock.getLease.mockResolvedValue(null);
    const res = await post(`/v1/leases/${LEASE_ID}/charges/generate`);
    expect(res.status).toBe(404);
  });

  it('409s on a draft lease', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow({ status: 'draft' }));
    const res = await post(`/v1/leases/${LEASE_ID}/charges/generate`);
    expect(res.status).toBe(409);
    expect(chargeRepoMock.generateChargesForLease).not.toHaveBeenCalled();
  });

  it('409s on a cancelled lease', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow({ status: 'cancelled' }));
    const res = await post(`/v1/leases/${LEASE_ID}/charges/generate`);
    expect(res.status).toBe(409);
  });

  it('runs the generator and returns { created: [...] } — an empty body, no `through`', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow());
    chargeRepoMock.generateChargesForLease.mockResolvedValue([chargeRow()]);

    const res = await post(`/v1/leases/${LEASE_ID}/charges/generate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.created).toHaveLength(1);
    // Called with no `through` argument of any kind — the manual kick is exactly
    // the cron's own work for this one lease.
    expect(chargeRepoMock.generateChargesForLease).toHaveBeenCalledWith(
      currentOrgId,
      expect.anything(),
      expect.objectContaining({ id: LEASE_ID }),
      [],
      expect.any(String),
    );
  });
});

describe('POST /v1/leases/:leaseId/charges/:chargeId/void', () => {
  it('404s when the repo finds no such (lease, charge)', async () => {
    chargeRepoMock.voidCharge.mockResolvedValue(null);
    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/void`, {
      reason: 'Charged in error, duplicate line.',
    });
    expect(res.status).toBe(404);
  });

  it('409s when already voided', async () => {
    chargeRepoMock.voidCharge.mockRejectedValue(conflict('This charge has already been voided.'));
    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/void`, {
      reason: 'Charged in error, duplicate line.',
    });
    expect(res.status).toBe(409);
  });

  it('422s on a reason under 10 characters', async () => {
    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/void`, { reason: 'too short' });
    expect(res.status).toBe(422);
    expect(chargeRepoMock.voidCharge).not.toHaveBeenCalled();
  });

  it('200s with the voided charge', async () => {
    chargeRepoMock.voidCharge.mockResolvedValue(
      chargeRow({ voidedAt: new Date('2026-04-02T00:00:00.000Z'), voidedReason: 'Charged in error.' }),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/void`, {
      reason: 'Charged in error, duplicate line.',
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/leases/:leaseId/charges/:chargeId/correct', () => {
  it('404s when the repo finds no such (lease, charge)', async () => {
    chargeRepoMock.correctCharge.mockResolvedValue(null);
    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/correct`, {
      amountCents: 1000,
      reason: 'Agreed a discount after the fact.',
    });
    expect(res.status).toBe(404);
  });

  it('201s with the successor charge', async () => {
    chargeRepoMock.correctCharge.mockResolvedValue(
      chargeRow({ id: '00000000-0000-7000-8000-00000000c002', supersedesChargeId: CHARGE_ID, source: 'manual', generationKey: null }),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/correct`, {
      amountCents: 1000,
      reason: 'Agreed a discount after the fact.',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.supersedesChargeId).toBe(CHARGE_ID);
  });

  it('422s on a reason under 10 characters', async () => {
    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/correct`, { amountCents: 1000, reason: 'nope' });
    expect(res.status).toBe(422);
  });
});

describe('GET /v1/charges — portfolio-wide', () => {
  it('returns mapped items with lease context', async () => {
    chargeRepoMock.listChargesForOrg.mockResolvedValue({ rows: [chargeWithLeaseRow()], hasMore: false });
    const res = await get('/v1/charges');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.items[0].propertyName).toBe('Maple Court');
  });

  it('400s on an invalid query param', async () => {
    const res = await get('/v1/charges?limit=not-a-number');
    expect(res.status).toBe(422);
  });
});

/* ======================================================================== *
 * §9.4 — landlord B holding landlord A's charge UUID
 * ======================================================================== */

describe('§9.4 landlord-vs-landlord: both path ids are scoped, neither alone is sufficient', () => {
  it("landlord B's void of landlord A's (lease, charge) 404s — the repo's (org, lease, id) resolve returns null before any UPDATE", async () => {
    currentOrgId = 'org_B';
    chargeRepoMock.voidCharge.mockResolvedValue(null); // what the REAL repo returns for a foreign org

    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/void`, {
      reason: 'Should never apply — wrong org entirely.',
    });
    expect(res.status).toBe(404);
    expect(chargeRepoMock.voidCharge).toHaveBeenCalledWith('org_B', expect.anything(), LEASE_ID, CHARGE_ID, 'user_1', expect.anything());
  });

  it("landlord B's correct of landlord A's (lease, charge) 404s", async () => {
    currentOrgId = 'org_B';
    chargeRepoMock.correctCharge.mockResolvedValue(null);

    const res = await post(`/v1/leases/${LEASE_ID}/charges/${CHARGE_ID}/correct`, {
      amountCents: 1,
      reason: 'Should never apply — wrong org entirely.',
    });
    expect(res.status).toBe(404);
  });

  it("landlord B's GET of landlord A's lease charges 404s — resolved via getLease, never the charge list alone", async () => {
    currentOrgId = 'org_B';
    leaseRepoMock.getLease.mockResolvedValue(null); // org B's own getLease never finds org A's lease

    const res = await get(`/v1/leases/${LEASE_ID}/charges`);
    expect(res.status).toBe(404);
    expect(chargeRepoMock.listCharges).not.toHaveBeenCalled();
  });
});
