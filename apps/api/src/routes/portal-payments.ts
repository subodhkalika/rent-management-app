import { Hono } from 'hono';
import { pageQuery, isoDate, localToday, type PageQuery } from '@rms/contract';
import { validateQuery, parsedQuery } from '../middleware/validate.js';
import { notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { encodeDueDateCursor } from '../lib/pagination.js';
import { mapPortalPayment, mapPortalBalance } from '../lib/mappers.js';
import * as portalLeaseRepo from '../db/repo/portal/lease.js';
import * as portalBalanceRepo from '../db/repo/portal/balance.js';
import * as paymentRepo from '../db/repo/payment.js';
import type { AppBindings } from '../types.js';

/**
 * Tenant-facing payment routes (PLAN-PHASE3B.md §8.2). Registered in its OWN
 * router and mounted in index.ts BEFORE `portal` — the identical
 * `/v1/portal/leases/...` routing footgun `routes/portal-charges.ts` already
 * documents: `routes.portal.profile` is `/v1/portal/:tenantId/profile`, so
 * without this ordering `/v1/portal/leases/:id/payments` would be captured as
 * `tenantId = "leases"`.
 *
 * The verify-then-scope shape: `resolveLease` runs FIRST and is the (org,
 * tenant) pair filter — same org, different tenant reads as zero rows, never
 * 403. Only once that has returned a trusted `orgId` does the ORDINARY
 * landlord repo function (`paymentRepo.listPayments`) run, covered by the
 * existing tenancy guard. There is no portal route that takes a payment id
 * directly — same shape decision 3a made for charges.
 */
export const portalPayments = new Hono<AppBindings>();

const portalPaymentListQuery = pageQuery.extend({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

portalPayments.get(
  '/v1/portal/leases/:id/payments',
  validateQuery(portalPaymentListQuery),
  async (c) => {
    const scope = c.get('tenantScope');
    const db = c.get('db');
    const leaseId = requireUuidParam(c.req.param('id'), 'Lease');
    const query = parsedQuery<PageQuery & { from?: string; to?: string }>(c);

    const resolved = await portalLeaseRepo.resolveLease(scope, db, leaseId);
    if (!resolved) throw notFound('Lease');

    const { rows, hasMore } = await paymentRepo.listPayments(resolved.orgId, db, leaseId, {
      ...query,
      includeVoided: true,
    });
    const items = rows.map(mapPortalPayment);
    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeDueDateCursor(last.receivedOn, last.id) : null;
    return c.json({ items, nextCursor });
  },
);

portalPayments.get('/v1/portal/leases/:id/balance', async (c) => {
  const scope = c.get('tenantScope');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');

  // `resolveLease` runs again inside `portalBalanceForLease` (it is the
  // verify-then-scope step every portal balance number depends on) — resolving
  // twice here only to read `propertyTimezone` for "today" would duplicate
  // that same query for nothing, so `today` is derived the one time the
  // function needs the resolved row anyway. A first resolve purely to 404
  // early is cheap and keeps the 404 path identical to every other portal
  // route's.
  const resolved = await portalLeaseRepo.resolveLease(scope, db, leaseId);
  if (!resolved) throw notFound('Lease');

  const today = localToday(resolved.propertyTimezone);
  const data = await portalBalanceRepo.portalBalanceForLease(scope, db, leaseId, today);
  if (!data) throw notFound('Lease');

  return c.json(mapPortalBalance(data));
});
