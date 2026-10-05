import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';

/**
 * Route-level tests for `DELETE /v1/properties/:id` — docs/PLAN-PHASE2.md §3.6's
 * new 409-while-any-unit-has-an-active-lease precondition. Every other property
 * route predates Phase 2 and is otherwise untouched here.
 */

let currentOrgId = 'org_A';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('orgId', currentOrgId);
    c.set('userId', 'user_1');
    await next();
  },
}));

const propertyRepoMock = { softDeleteProperty: vi.fn() };
vi.mock('../db/repo/property.js', () => propertyRepoMock);

const leaseRepoMock = { countActiveLeasesForProperty: vi.fn() };
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
