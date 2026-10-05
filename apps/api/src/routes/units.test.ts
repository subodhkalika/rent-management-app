import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { ApiException } from '../lib/errors.js';
import type { AppBindings } from '../types.js';
import { authLayer } from '../middleware/auth-layer.js';

/**
 * Route-level tests for `DELETE /v1/units/:id` — docs/PLAN-PHASE2.md §3.6's new
 * 409-while-active-lease precondition. Every other unit route is exercised at the
 * repo level (`db/repo/unit.test.ts`) and was already covered before Phase 2.
 */

let currentOrgId = 'org_A';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('orgId', currentOrgId);
    c.set('userId', 'user_1');
    await next();
  },
}));

const unitRepoMock = { softDeleteUnit: vi.fn() };
vi.mock('../db/repo/unit.js', () => unitRepoMock);

const leaseRepoMock = { countActiveLeasesForUnit: vi.fn() };
vi.mock('../db/repo/lease.js', () => leaseRepoMock);

const { units } = await import('./units.js');

function buildApp() {
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    await next();
  });
  app.use('/v1/*', authLayer);
  app.route('/', units);
  app.onError((err, c) => {
    if (err instanceof ApiException) return c.json(err.toBody(), err.status);
    throw err;
  });
  return app;
}

const testEnv = { WEB_ORIGIN: 'https://app.example.com' };
const UNIT_ID = '00000000-0000-7000-8000-00000000d001';

beforeEach(() => {
  currentOrgId = 'org_A';
  vi.clearAllMocks();
});

describe('DELETE /v1/units/:id — docs/PLAN-PHASE2.md §3.6', () => {
  it('409s while the unit has an active lease', async () => {
    leaseRepoMock.countActiveLeasesForUnit.mockResolvedValue(1);

    const res = await buildApp().request(`/v1/units/${UNIT_ID}`, { method: 'DELETE' }, testEnv);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('active lease');
    expect(unitRepoMock.softDeleteUnit).not.toHaveBeenCalled();
  });

  it('deletes normally when the unit has no active lease', async () => {
    leaseRepoMock.countActiveLeasesForUnit.mockResolvedValue(0);
    unitRepoMock.softDeleteUnit.mockResolvedValue(true);

    const res = await buildApp().request(`/v1/units/${UNIT_ID}`, { method: 'DELETE' }, testEnv);

    expect(res.status).toBe(204);
  });

  it('the active-lease count is scoped by the session orgId, never a forged one', async () => {
    currentOrgId = 'org_B';
    leaseRepoMock.countActiveLeasesForUnit.mockResolvedValue(0);
    unitRepoMock.softDeleteUnit.mockResolvedValue(false);

    await buildApp().request(`/v1/units/${UNIT_ID}`, { method: 'DELETE' }, testEnv);

    expect(leaseRepoMock.countActiveLeasesForUnit).toHaveBeenCalledWith('org_B', expect.anything(), UNIT_ID);
  });
});
