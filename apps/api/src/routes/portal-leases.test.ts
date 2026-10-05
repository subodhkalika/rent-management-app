import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scheduleFixtures } from '@rms/contract';
import { ApiException } from '../lib/errors.js';
import type { AppBindings, TenantScope } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';
import type { PortalLeaseDetailRow } from '../db/repo/portal/lease.js';

/**
 * Route-level tests for the tenant-facing lease endpoints — the whole of
 * PLAN-PHASE2.md §7's attack table, plus `scheduleFixtures` asserted through the
 * real HTTP route.
 */

const TENANT_A1 = '00000000-0000-7000-8000-00000000a001'; // Dana, in org A
const LEASE_L1 = '00000000-0000-7000-8000-00000000c001'; // Dana's own lease

let currentScope: TenantScope = { userId: 'user_dana', pairs: [{ orgId: 'org_A', tenantId: TENANT_A1 }] };
vi.mock('../middleware/auth.js', () => ({
  requireTenant: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('tenantScope', currentScope);
    await next();
  },
}));

const portalLeaseRepoMock = {
  listLeases: vi.fn(),
  resolveLease: vi.fn(),
  resolveActiveLease: vi.fn(),
  listCoTenants: vi.fn(),
};
vi.mock('../db/repo/portal/lease.js', () => portalLeaseRepoMock);

const { portalLeases } = await import('./portal-leases.js');
// Also import the plain `portal` router, to prove the registration-order fix:
// mounting `portalLeases` BEFORE `portal` means `/v1/portal/leases/:id` is never
// captured by `portal`'s `/v1/portal/:tenantId/profile`.
const profileRepoMock = { getProfile: vi.fn(), updateProfile: vi.fn() };
vi.mock('../db/repo/portal/profile.js', () => profileRepoMock);
const { portal } = await import('./portal.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  // Mirrors index.ts's mount order EXACTLY — portalLeases before portal.
  app.route('/', portalLeases);
  app.route('/', portal);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };

function portalLeaseDetailRow(overrides: Partial<PortalLeaseDetailRow> = {}): PortalLeaseDetailRow {
  return {
    id: LEASE_L1,
    orgId: 'org_A',
    landlordName: 'Alice Lettings',
    status: 'active',
    unitLabel: '2B',
    propertyName: 'Maple Court',
    addressLine1: '123 Maple St',
    addressLine2: null,
    city: 'Springfield',
    region: 'IL',
    postalCode: '62704',
    country: 'US',
    propertyTimezone: 'America/Chicago',
    calendar: 'gregorian',
    startDate: '2026-01-01',
    endDate: null,
    moveOutDate: null,
    rentCents: 150000,
    currency: 'USD',
    rentFrequency: 'monthly',
    billingDay: 1,
    depositCents: 0,
    moveOutBillingPolicy: 'bill_full_term',
    removedOn: null,
    ledgerStartDate: '2026-01-01',
    coTenants: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentScope = { userId: 'user_dana', pairs: [{ orgId: 'org_A', tenantId: TENANT_A1 }] };
});

async function get(path: string) {
  return buildApp().request(path, {}, testEnv);
}

/* ======================================================================== *
 * §7 — the tenant attack walk
 * ======================================================================== */

describe('§7 tenant attack walk', () => {
  it("GET /v1/portal/leases/L_X (another org's tenant's lease) -> 404", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_L1}`);
    expect(res.status).toBe(404);
  });

  it('GET /v1/portal/leases/L_N (next-door neighbour, SAME org) -> 404, the dangerous one', async () => {
    // The repo's own pair filter already excludes it — the route just surfaces null.
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_L1}`);
    expect(res.status).toBe(404);
    expect(portalLeaseRepoMock.resolveLease).toHaveBeenCalledWith(currentScope, expect.anything(), LEASE_L1);
  });

  it('GET /v1/portal/leases/L_X/schedule -> 404, resolveLease called FIRST, buildSchedule never reached', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(null);
    const res = await get(`/v1/portal/leases/${LEASE_L1}/schedule?through=2026-06-01`);
    expect(res.status).toBe(404);
  });

  it('GET /v1/portal/leases/{own L1}?orgId=C — the forged param is ignored', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(portalLeaseDetailRow());
    const res = await get(`/v1/portal/leases/${LEASE_L1}?orgId=org_C`);
    expect(res.status).toBe(200);
    expect(portalLeaseRepoMock.resolveLease).toHaveBeenCalledWith(currentScope, expect.anything(), LEASE_L1);
  });

  it('Dana was removed from L1 -> 200, yourRole: former', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(portalLeaseDetailRow({ removedOn: '2026-03-01' }));
    const res = await get(`/v1/portal/leases/${LEASE_L1}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { yourRole: string; removedOn: string };
    expect(body.yourRole).toBe('former');
    expect(body.removedOn).toBe('2026-03-01');
  });

  it("a co-tenant's email/phone is structurally absent from coTenants", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(
      portalLeaseDetailRow({ coTenants: [{ firstName: 'Evan', lastName: 'Ng', isPrimary: false, isCurrent: true }] }),
    );
    const res = await get(`/v1/portal/leases/${LEASE_L1}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toMatch(/email|phone/i);
  });

  it("the landlord's lease.notes is structurally absent from the response", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(portalLeaseDetailRow());
    const res = await get(`/v1/portal/leases/${LEASE_L1}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.notes).toBeUndefined();
  });

  it('?through=9999-12-31 on the portal schedule -> 422', async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(portalLeaseDetailRow({ startDate: '2026-01-01' }));
    const res = await get(`/v1/portal/leases/${LEASE_L1}/schedule?through=9999-12-31`);
    expect(res.status).toBe(422);
  });

  it('GET /v1/portal/leases is unpaginated — no cursor accepted or returned', async () => {
    portalLeaseRepoMock.listLeases.mockResolvedValue([portalLeaseDetailRow()]);
    const res = await get('/v1/portal/leases');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor?: unknown };
    expect(body.nextCursor).toBeUndefined();
    expect(Array.isArray(body.items)).toBe(true);
  });
});

/* ======================================================================== *
 * Routing footgun (§4.2) — portalLeases mounted BEFORE portal
 * ======================================================================== */

describe('mount order — /v1/portal/leases/:id is never captured by /v1/portal/:tenantId/profile', () => {
  it("GET /v1/portal/leases/{uuid} calls the LEASE repo, never profileRepo.getProfile", async () => {
    portalLeaseRepoMock.resolveLease.mockResolvedValue(portalLeaseDetailRow());
    const res = await get(`/v1/portal/leases/${LEASE_L1}`);
    expect(res.status).toBe(200);
    expect(portalLeaseRepoMock.resolveLease).toHaveBeenCalled();
    expect(profileRepoMock.getProfile).not.toHaveBeenCalled();
  });

  it('GET /v1/portal/{tenantId}/profile still works — the fallthrough is untouched', async () => {
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
    const res = await get(`/v1/portal/${TENANT_A1}/profile`);
    expect(res.status).toBe(200);
  });
});

/* ======================================================================== *
 * scheduleFixtures asserted through the real HTTP route
 * ======================================================================== */

describe('GET /v1/portal/leases/:id/schedule — scheduleFixtures through the HTTP route', () => {
  for (const fixture of scheduleFixtures) {
    it(`${fixture.name}: matches the contract's buildSchedule exactly`, async () => {
      portalLeaseRepoMock.resolveLease.mockResolvedValue(
        portalLeaseDetailRow({
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

      const res = await get(`/v1/portal/leases/${LEASE_L1}/schedule?through=${fixture.through}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { periods: unknown[] };
      expect(body.periods).toEqual(fixture.expected);
    });
  }
});
