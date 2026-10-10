import { Hono } from 'hono';
import { z } from 'zod';
import {
  arrearsQuery,
  localToday,
  queryBoolean,
  LEDGER_MAX_ENTRIES,
  type ArrearsQuery,
} from '@rms/contract';
import { validateQuery, parsedQuery } from '../middleware/validate.js';
import { notFound } from '../lib/errors.js';
import { requireUuidParam } from '../lib/params.js';
import { mapLedgerEntry, mapLedgerLease, mapChainBalance, mapLeaseBalanceResponse, mapArrearsResponse } from '../lib/mappers.js';
import * as leaseRepo from '../db/repo/lease.js';
import * as ledgerRepo from '../db/repo/ledger.js';
import type { AppBindings } from '../types.js';

export const ledger = new Hono<AppBindings>();

// Auth is applied centrally in src/index.ts — see middleware/auth-layer.ts.

const ledgerQuery = z.object({ includeVoided: queryBoolean.default(true) });

/**
 * `GET /v1/leases/:id/ledger` — the WHOLE chain, labelled per entry with its
 * own `leaseId` (§8.1). `today` is `localToday(property.timezone)`, resolved
 * from the REQUESTED lease's own property — never the server's clock, and
 * never the request. The chain spans at most one property (a renewal never
 * changes unit), so one timezone covers every row in the response.
 */
ledger.get('/v1/leases/:id/ledger', validateQuery(ledgerQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');
  const query = parsedQuery<{ includeVoided: boolean }>(c);

  const current = await leaseRepo.getLease(orgId, db, leaseId);
  if (!current) throw notFound('Lease');

  const today = localToday(current.propertyTimezone);
  const data = await ledgerRepo.leaseLedger(orgId, db, leaseId, today, { includeVoided: query.includeVoided });
  if (!data) throw notFound('Lease');

  const truncated = data.entries.length > LEDGER_MAX_ENTRIES;
  const limitedEntries = truncated ? data.entries.slice(0, LEDGER_MAX_ENTRIES) : data.entries;

  return c.json({
    chainId: data.chainId,
    currency: data.currency,
    asOfDate: data.asOfDate,
    leases: data.leases.map(mapLedgerLease),
    entries: limitedEntries.map((e) => mapLedgerEntry(e, today)),
    balance: mapChainBalance(data.balance),
    truncated,
  });
});

/**
 * `GET /v1/leases/:id/balance` — both slices in one response (§5.3): the
 * chain's real financial position, plus this one lease's restriction of it.
 */
ledger.get('/v1/leases/:id/balance', async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const leaseId = requireUuidParam(c.req.param('id'), 'Lease');

  const current = await leaseRepo.getLease(orgId, db, leaseId);
  if (!current) throw notFound('Lease');

  const today = localToday(current.propertyTimezone);
  const data = await ledgerRepo.leaseAndChainBalance(orgId, db, leaseId, today);
  if (!data) throw notFound('Lease');

  return c.json(mapLeaseBalanceResponse(data));
});

/**
 * `GET /v1/arrears` — portfolio-wide, grouped by currency (§6.2). Spans every
 * property in the org, possibly several timezones at once — `repo/ledger.ts`'s
 * `orgArrears` decides "overdue" per charge, in THAT charge's own property's
 * timezone, never a single date shared across the call. The `asOfDate` on the
 * RESPONSE is a display stamp only (UTC), not what decided any row's arrears.
 */
ledger.get('/v1/arrears', validateQuery(arrearsQuery), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('db');
  const query = parsedQuery<ArrearsQuery>(c);

  const { rows, truncated } = await ledgerRepo.orgArrears(orgId, db, {
    propertyId: query.propertyId,
    currency: query.currency,
    minCents: query.minCents,
  });

  return c.json(mapArrearsResponse(rows, truncated, localToday('UTC')));
});
