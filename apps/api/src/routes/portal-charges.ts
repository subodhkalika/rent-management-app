import { Hono } from 'hono';
import { chargeListQuery, type ChargeListQuery } from '@rms/contract';
import { validateQuery, parsedQuery } from '../middleware/validate.js';
import { notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { encodeDueDateCursor } from '../lib/pagination.js';
import { mapPortalCharge } from '../lib/mappers.js';
import * as portalLeaseRepo from '../db/repo/portal/lease.js';
import * as chargeRepo from '../db/repo/charge.js';
import type { AppBindings } from '../types.js';

/**
 * Tenant-facing charge routes. Registered in its OWN router and mounted in
 * index.ts BEFORE `portal` — the identical `/v1/portal/leases/...` routing footgun
 * `routes/portal-leases.ts` already documents: `routes.portal.profile` is
 * `/v1/portal/:tenantId/profile`, so without this ordering
 * `/v1/portal/leases/:id/charges` would be captured as `tenantId = "leases"`.
 *
 * The verify-then-scope shape (PLAN-PHASE3A.md §9.4): `resolveLease` runs FIRST and
 * is the (org, tenant) pair filter — same org, different tenant reads as zero rows,
 * never 403. Only once that has returned a trusted `orgId` does `listCharges` (the
 * ORDINARY landlord repo function) run, covered by the existing tenancy guard.
 * There is no portal route that takes a charge id directly — charges are listed by
 * VERIFIED LEASE id only, which is the shape decision that makes a charge-id-level
 * guard unnecessary here.
 */
export const portalCharges = new Hono<AppBindings>();

portalCharges.get('/v1/portal/leases/:id/charges', validateQuery(chargeListQuery), async (c) => {
  const scope = c.get('tenantScope');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');
  const query = parsedQuery<ChargeListQuery>(c);

  const resolved = await portalLeaseRepo.resolveLease(scope, db, leaseId);
  if (!resolved) throw notFound('Lease');

  const { rows, hasMore } = await chargeRepo.listCharges(resolved.orgId, db, leaseId, query);
  const items = rows.map(mapPortalCharge);
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeDueDateCursor(last.dueDate, last.id) : null;
  return c.json({ items, nextCursor });
});
