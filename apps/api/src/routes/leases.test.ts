import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scheduleFixtures, bsScheduleFixtures, bsYearlyFixture } from '@rms/contract';
import { ApiException, conflict, notFound } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';
import type { LeaseRow } from '../db/repo/lease.js';

/**
 * Route-level tests for the landlord lease endpoints.
 *
 * `requireAuth` is mocked to a trivial pass-through that sets `orgId`/`userId` from
 * whatever the test configures. These tests are about what the ROUTE does once a
 * landlord is already authenticated: the whole of PLAN-PHASE2.md §7.1's attack
 * table, every §5.2 illegal transition, and `scheduleFixtures` asserted through the
 * real HTTP route so the API and the contract cannot drift.
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

const leaseRepoMock = {
  listLeases: vi.fn(),
  getLease: vi.fn(),
  getLeaseDetail: vi.fn(),
  createLease: vi.fn(),
  updateLease: vi.fn(),
  activateLease: vi.fn(),
  cancelLease: vi.fn(),
  endLease: vi.fn(),
  renewLease: vi.fn(),
  hardDeleteLease: vi.fn(),
  addLeaseTenant: vi.fn(),
  removeLeaseTenant: vi.fn(),
  setPrimaryTenant: vi.fn(),
};
vi.mock('../db/repo/lease.js', () => leaseRepoMock);

const { leases } = await import('./leases.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', leases);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };
const LEASE_ID = '00000000-0000-7000-8000-00000000b001';
const A_UNIT = '00000000-0000-7000-8000-00000000a010';
const A_TENANT = '00000000-0000-7000-8000-00000000a020';

function leaseRow(overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    id: LEASE_ID,
    chainId: LEASE_ID,
    status: 'draft',
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
    tenantCount: 1,
    primaryTenantName: 'Dana Lee',
    renewedFromLeaseId: null,
    endReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  currentOrgId = 'org_A';
  currentUserId = 'user_1';
  vi.clearAllMocks();
});

async function post(path: string, json: unknown) {
  return buildApp().request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) },
    testEnv,
  );
}

async function patch(path: string, json: unknown) {
  return buildApp().request(
    path,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) },
    testEnv,
  );
}

async function get(path: string) {
  return buildApp().request(path, {}, testEnv);
}

/* ======================================================================== *
 * §7.1 — landlord B holding landlord A's UUIDs
 * ======================================================================== */

describe('§7.1 landlord-vs-landlord attack table', () => {
  it("POST /v1/leases { unitId: A_unit } -> 404, never trusting the body's unit", async () => {
    leaseRepoMock.createLease.mockRejectedValue(notFound('Unit'));
    currentOrgId = 'org_B';

    const res = await post('/v1/leases', {
      unitId: A_UNIT,
      tenantIds: [A_TENANT],
      primaryTenantId: A_TENANT,
      startDate: '2026-01-01',
      rentCents: 100000,
      rentFrequency: 'monthly',
    });

    expect(res.status).toBe(404);
    // orgId passed to the repo is ALWAYS the session's, never read from the body.
    expect(leaseRepoMock.createLease).toHaveBeenCalledWith('org_B', expect.anything(), 'user_1', expect.anything());
  });

  it("POST /v1/leases { tenantIds: [A_tenant] } -> 404 — THE §7.1 roster-insert guard", async () => {
    // Simulates createLease's real behaviour: resolveTenantIds(orgId, ...) comes
    // back short, so createLease throws notFound('Tenant') before any INSERT.
    leaseRepoMock.createLease.mockRejectedValue(notFound('Tenant'));
    currentOrgId = 'org_B';

    const res = await post('/v1/leases', {
      unitId: '00000000-0000-7000-8000-00000000b010',
      tenantIds: [A_TENANT],
      primaryTenantId: A_TENANT,
      startDate: '2026-01-01',
      rentCents: 100000,
      rentFrequency: 'monthly',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it("POST /v1/leases/{own draft}/tenants { tenantId: A_tenant } -> 404, same guard", async () => {
    leaseRepoMock.addLeaseTenant.mockRejectedValue(notFound('Tenant'));
    currentOrgId = 'org_B';

    const res = await post(`/v1/leases/${LEASE_ID}/tenants`, { tenantId: A_TENANT, isPrimary: false });

    expect(res.status).toBe(404);
  });

  it("POST /v1/leases/{A_lease}/activate -> 404, never reaching lease_unit_active_uq", async () => {
    leaseRepoMock.activateLease.mockResolvedValue(null); // getLease(orgId=B,...) found nothing
    currentOrgId = 'org_B';

    const res = await post(`/v1/leases/${LEASE_ID}/activate`, {});

    expect(res.status).toBe(404);
    expect(leaseRepoMock.activateLease).toHaveBeenCalledWith('org_B', expect.anything(), LEASE_ID);
  });

  it('GET /v1/leases/{A_lease}/schedule -> 404', async () => {
    leaseRepoMock.getLease.mockResolvedValue(null);
    currentOrgId = 'org_B';

    const res = await get(`/v1/leases/${LEASE_ID}/schedule?through=2026-06-01`);

    expect(res.status).toBe(404);
  });

  it('a forged ?orgId= query param on GET /v1/leases is ignored — the session value always wins', async () => {
    leaseRepoMock.listLeases.mockResolvedValue({ rows: [], hasMore: false });

    await get('/v1/leases?orgId=org_B&limit=5');

    expect(leaseRepoMock.listLeases).toHaveBeenCalledWith('org_A', expect.anything(), expect.anything());
  });

  it("GET /v1/leases/{own lease}?... never leaks another org's row even with a forged id", async () => {
    leaseRepoMock.getLeaseDetail.mockResolvedValue(null);

    const res = await get(`/v1/leases/${LEASE_ID}`);

    expect(res.status).toBe(404);
  });
});

/* ======================================================================== *
 * §5.2 — illegal transitions, exact 409s
 * ======================================================================== */

describe('§5.2 illegal transitions', () => {
  it("activate on anything but draft -> 409 'Only a draft lease can be activated.'", async () => {
    leaseRepoMock.activateLease.mockRejectedValue(conflict('Only a draft lease can be activated.'));
    const res = await post(`/v1/leases/${LEASE_ID}/activate`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'Only a draft lease can be activated.',
    );
  });

  it('activate where the unit already has an active lease -> 409 named message', async () => {
    leaseRepoMock.activateLease.mockRejectedValue(
      conflict('This unit already has an active lease. End the current lease before starting a new one.'),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/activate`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'already has an active lease',
    );
  });

  it('activate on an unavailable unit -> 409 named message', async () => {
    leaseRepoMock.activateLease.mockRejectedValue(
      conflict('This unit is marked unavailable. Change its status before activating a lease.'),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/activate`, {});
    expect(res.status).toBe(409);
  });

  it('activate with no tenants / no primary -> 409 named message', async () => {
    leaseRepoMock.activateLease.mockRejectedValue(
      conflict('Add at least one tenant and mark one as primary before activating.'),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/activate`, {});
    expect(res.status).toBe(409);
  });

  it("end on a draft -> 409 'Activate the lease first, or cancel it.'", async () => {
    leaseRepoMock.endLease.mockRejectedValue(conflict('Activate the lease first, or cancel it.'));
    const res = await post(`/v1/leases/${LEASE_ID}/end`, {
      endDate: '2026-06-01',
      reason: 'term_ended',
    });
    expect(res.status).toBe(409);
  });

  it("end on an already-ended lease -> 409 'This lease has already ended.'", async () => {
    leaseRepoMock.endLease.mockRejectedValue(conflict('This lease has already ended.'));
    const res = await post(`/v1/leases/${LEASE_ID}/end`, {
      endDate: '2026-06-01',
      reason: 'term_ended',
    });
    expect(res.status).toBe(409);
  });

  it('cancel on anything but draft -> 409', async () => {
    leaseRepoMock.cancelLease.mockRejectedValue(conflict('Only a draft lease can be cancelled.'));
    const res = await post(`/v1/leases/${LEASE_ID}/cancel`, {});
    expect(res.status).toBe(409);
  });

  it("renew from draft/terminated/cancelled -> 409 'Only an active or ended lease can be renewed.'", async () => {
    leaseRepoMock.renewLease.mockRejectedValue(conflict('Only an active or ended lease can be renewed.'));
    const res = await post(`/v1/leases/${LEASE_ID}/renew`, {
      startDate: '2026-02-01',
      rentCents: 100000,
    });
    expect(res.status).toBe(409);
  });

  it("renew whose startDate overlaps the predecessor's term -> 409", async () => {
    leaseRepoMock.renewLease.mockRejectedValue(
      conflict("The renewal's startDate must be after the current lease's startDate."),
    );
    const res = await post(`/v1/leases/${LEASE_ID}/renew`, {
      startDate: '2025-01-01',
      rentCents: 100000,
    });
    expect(res.status).toBe(409);
  });

  it("DELETE on active/ended/terminated -> 409 'kept for the record'", async () => {
    leaseRepoMock.hardDeleteLease.mockResolvedValue('blocked');
    const res = await buildApp().request(`/v1/leases/${LEASE_ID}`, { method: 'DELETE' }, testEnv);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('kept for the record');
  });

  it('DELETE on a non-existent/foreign lease -> 404', async () => {
    leaseRepoMock.hardDeleteLease.mockResolvedValue(false);
    const res = await buildApp().request(`/v1/leases/${LEASE_ID}`, { method: 'DELETE' }, testEnv);
    expect(res.status).toBe(404);
  });

  it('DELETE on a draft/cancelled lease -> 204', async () => {
    leaseRepoMock.hardDeleteLease.mockResolvedValue(true);
    const res = await buildApp().request(`/v1/leases/${LEASE_ID}`, { method: 'DELETE' }, testEnv);
    expect(res.status).toBe(204);
  });

  it('PATCH an immutable field on a non-draft lease -> 409 naming /renew', async () => {
    leaseRepoMock.updateLease.mockRejectedValue(
      conflict('rentCents cannot be changed on a lease that has been active. Use /renew instead.'),
    );
    const res = await patch(`/v1/leases/${LEASE_ID}`, { rentCents: 999999 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('/renew');
  });

  it('PATCH a shortened endDate on an active lease -> 409 naming /end', async () => {
    leaseRepoMock.updateLease.mockRejectedValue(
      conflict('Shortening endDate is ending the lease early. Use /end instead.'),
    );
    const res = await patch(`/v1/leases/${LEASE_ID}`, { endDate: '2026-01-01' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('/end');
  });
});

/* ======================================================================== *
 * scheduleFixtures asserted through the real HTTP route
 * ======================================================================== */

describe('GET /v1/leases/:id/schedule — scheduleFixtures through the HTTP route', () => {
  for (const fixture of scheduleFixtures) {
    it(`${fixture.name}: amountCents and dueDate match the contract's buildSchedule exactly`, async () => {
      leaseRepoMock.getLease.mockResolvedValue(
        leaseRow({
          rentFrequency: fixture.terms.frequency,
          calendar: fixture.terms.calendar,
          rentCents: fixture.terms.rentCents,
          billingDay: fixture.terms.billingDay,
          startDate: fixture.terms.startDate,
          endDate: fixture.terms.endDate,
          ledgerStartDate: fixture.terms.ledgerStartDate,
          moveOutDate: fixture.terms.moveOutDate,
          moveOutBillingPolicy: fixture.terms.moveOutBillingPolicy,
        }),
      );

      const res = await get(`/v1/leases/${LEASE_ID}/schedule?through=${fixture.through}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { periods: unknown[]; leaseId: string; computedThrough: string };
      expect(body.periods).toEqual(fixture.expected);
      expect(body.leaseId).toBe(LEASE_ID);
      expect(body.computedThrough).toBe(fixture.through);
    });
  }

  it('a through more than 10 years past startDate is 422, not a RangeError 500', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow({ startDate: '2026-01-01' }));
    const res = await get(`/v1/leases/${LEASE_ID}/schedule?through=2040-01-01`);
    expect(res.status).toBe(422);
  });

  // Bikram Sambat fixtures — the BS counterpart of the Gregorian loop above. No
  // existing test exercised the BS route end to end before this: every one of
  // scheduleFixtures is Gregorian, so the "year + 10 past BS_MAX_YEAR" 500 a live
  // Docker run caught was invisible to the whole suite.
  for (const fixture of [...bsScheduleFixtures, bsYearlyFixture]) {
    it(`[BS] ${fixture.name}: matches the contract's buildSchedule exactly`, async () => {
      leaseRepoMock.getLease.mockResolvedValue(
        leaseRow({
          rentFrequency: fixture.terms.frequency,
          calendar: fixture.terms.calendar,
          rentCents: fixture.terms.rentCents,
          billingDay: fixture.terms.billingDay,
          startDate: fixture.terms.startDate,
          endDate: fixture.terms.endDate,
          ledgerStartDate: fixture.terms.ledgerStartDate,
          moveOutDate: fixture.terms.moveOutDate,
          moveOutBillingPolicy: fixture.terms.moveOutBillingPolicy,
        }),
      );

      const res = await get(`/v1/leases/${LEASE_ID}/schedule?through=${fixture.through}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { periods: unknown[] };
      expect(body.periods).toEqual(fixture.expected);
    });
  }
});

describe('GET /v1/leases/:id/schedule — the Bikram Sambat 500 a live run caught, now fixed', () => {
  it('a BS lease requesting a near-term schedule succeeds (the sanity bound no longer throws unconditionally)', async () => {
    leaseRepoMock.getLease.mockResolvedValue(
      leaseRow({ calendar: 'bikram_sambat', startDate: '2026-09-26', ledgerStartDate: '2026-09-26' }),
    );
    const res = await get(`/v1/leases/${LEASE_ID}/schedule?through=2027-09-26`);
    expect(res.status).toBe(200);
  });

  it('a BS lease genuinely extending past the data table returns a clear 422, never a 500', async () => {
    leaseRepoMock.getLease.mockResolvedValue(
      leaseRow({ calendar: 'bikram_sambat', startDate: '2026-01-01', ledgerStartDate: '2026-01-01' }),
    );
    // `through` must stay INSIDE the 10-year sanity bound from 2026 (~2036) so
    // this exercises buildSchedule's OWN BsDateOutOfRangeError, not the generic
    // sanity-bound rejection every through-too-far-out request gets regardless of
    // calendar — those are two different code paths with two different messages,
    // and asserting only the generic wrapper message ("Some fields are invalid")
    // cannot tell them apart. A prior version of this test used `through:
    // 2040-01-01` from a 1950 startDate — 90 years out, past the 10-year sanity
    // bound — so it passed by hitting the WRONG branch; schedule.test.ts's
    // `buildScheduleOrThrow` tests are what actually exercise this one directly.
    const res = await get(`/v1/leases/${LEASE_ID}/schedule?through=2034-06-01`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details?: { through?: string[] } } };
    expect(body.error.details?.through?.[0]).toMatch(/Bikram Sambat/);
    expect(body.error.details?.through?.[0]).not.toMatch(/within 10 years/);
  });

  it('the Gregorian path is unaffected by any of the BS fix', async () => {
    leaseRepoMock.getLease.mockResolvedValue(leaseRow({ calendar: 'gregorian', startDate: '2026-01-01' }));
    const res = await get(`/v1/leases/${LEASE_ID}/schedule?through=2026-12-01`);
    expect(res.status).toBe(200);
  });
});
