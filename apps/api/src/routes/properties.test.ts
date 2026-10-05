import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';

/**
 * Route-level tests for `DELETE /v1/properties/:id` (docs/PLAN-PHASE2.md §3.6's
 * new 409-while-any-unit-has-an-active-lease precondition) and `PATCH
 * /v1/properties/:id { calendar }` (the BLOCKING 3 review finding: a calendar
 * change silently redefines every lease's billing periods under the property).
 * Every other property route predates Phase 2 and is otherwise untouched here.
 */

let currentOrgId = 'org_A';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('orgId', currentOrgId);
    c.set('userId', 'user_1');
    await next();
  },
}));

const propertyRepoMock = { softDeleteProperty: vi.fn(), getProperty: vi.fn(), updateProperty: vi.fn() };
vi.mock('../db/repo/property.js', () => propertyRepoMock);

const leaseRepoMock = { countActiveLeasesForProperty: vi.fn(), countNonDraftLeasesForProperty: vi.fn() };
vi.mock('../db/repo/lease.js', () => leaseRepoMock);

const { properties } = await import('./properties.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', properties);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };
const PROPERTY_ID = '00000000-0000-7000-8000-00000000e001';

beforeEach(() => {
  currentOrgId = 'org_A';
  vi.clearAllMocks();
});

describe('DELETE /v1/properties/:id — docs/PLAN-PHASE2.md §3.6', () => {
  it('409s while any unit under the property has an active lease', async () => {
    leaseRepoMock.countActiveLeasesForProperty.mockResolvedValue(1);

    const res = await buildApp().request(`/v1/properties/${PROPERTY_ID}`, { method: 'DELETE' }, testEnv);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('active lease');
    expect(propertyRepoMock.softDeleteProperty).not.toHaveBeenCalled();
  });

  it('deletes normally when no unit under the property has an active lease', async () => {
    leaseRepoMock.countActiveLeasesForProperty.mockResolvedValue(0);
    propertyRepoMock.softDeleteProperty.mockResolvedValue(true);

    const res = await buildApp().request(`/v1/properties/${PROPERTY_ID}`, { method: 'DELETE' }, testEnv);

    expect(res.status).toBe(204);
  });

  it('the active-lease count is scoped by the session orgId, never a forged one', async () => {
    currentOrgId = 'org_B';
    leaseRepoMock.countActiveLeasesForProperty.mockResolvedValue(0);
    propertyRepoMock.softDeleteProperty.mockResolvedValue(false);

    await buildApp().request(`/v1/properties/${PROPERTY_ID}`, { method: 'DELETE' }, testEnv);

    expect(leaseRepoMock.countActiveLeasesForProperty).toHaveBeenCalledWith('org_B', expect.anything(), PROPERTY_ID);
  });
});

function propertyRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROPERTY_ID,
    name: 'Maple Court',
    type: 'apartment',
    addressLine1: '1 Test St',
    addressLine2: null,
    city: 'Springfield',
    region: 'IL',
    postalCode: '62704',
    country: 'US',
    notes: null,
    timezone: 'America/Chicago',
    moveOutBillingPolicy: 'bill_full_term',
    calendar: 'gregorian',
    unitCount: 1,
    occupiedUnitCount: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function patch(path: string, json: unknown) {
  return buildApp().request(
    path,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) },
    testEnv,
  );
}

describe('PATCH /v1/properties/:id { calendar } — BLOCKING 3', () => {
  it('409s when calendar is changing and a non-draft/cancelled lease exists under the property', async () => {
    propertyRepoMock.getProperty.mockResolvedValue(propertyRow({ calendar: 'gregorian' }));
    leaseRepoMock.countNonDraftLeasesForProperty.mockResolvedValue(1);

    const res = await patch(`/v1/properties/${PROPERTY_ID}`, { calendar: 'bikram_sambat' });

    expect(res.status).toBe(409);
    expect(propertyRepoMock.updateProperty).not.toHaveBeenCalled();
  });

  it('allows the calendar change when no lease blocks it', async () => {
    propertyRepoMock.getProperty.mockResolvedValue(propertyRow({ calendar: 'gregorian' }));
    leaseRepoMock.countNonDraftLeasesForProperty.mockResolvedValue(0);
    propertyRepoMock.updateProperty.mockResolvedValue(propertyRow({ calendar: 'bikram_sambat' }));

    const res = await patch(`/v1/properties/${PROPERTY_ID}`, { calendar: 'bikram_sambat' });

    expect(res.status).toBe(200);
  });

  it('never checks lease-blocking when calendar is absent from the patch', async () => {
    propertyRepoMock.updateProperty.mockResolvedValue(propertyRow({ name: 'New name' }));

    const res = await patch(`/v1/properties/${PROPERTY_ID}`, { name: 'New name' });

    expect(res.status).toBe(200);
    expect(leaseRepoMock.countNonDraftLeasesForProperty).not.toHaveBeenCalled();
  });

  it('never checks lease-blocking when the patch repeats the SAME calendar value', async () => {
    propertyRepoMock.getProperty.mockResolvedValue(propertyRow({ calendar: 'gregorian' }));
    propertyRepoMock.updateProperty.mockResolvedValue(propertyRow({ calendar: 'gregorian' }));

    const res = await patch(`/v1/properties/${PROPERTY_ID}`, { calendar: 'gregorian' });

    expect(res.status).toBe(200);
    expect(leaseRepoMock.countNonDraftLeasesForProperty).not.toHaveBeenCalled();
  });

  it('404s rather than leaking existence when the property belongs to another org', async () => {
    propertyRepoMock.getProperty.mockResolvedValue(null);

    const res = await patch(`/v1/properties/${PROPERTY_ID}`, { calendar: 'bikram_sambat' });

    expect(res.status).toBe(404);
    expect(propertyRepoMock.updateProperty).not.toHaveBeenCalled();
  });
});
