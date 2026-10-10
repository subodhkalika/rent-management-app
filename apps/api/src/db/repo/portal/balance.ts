import { chargeOverdue, compareIsoDate, type IsoDate } from '@rms/contract';
import type { Database } from '../../index.js';
import type { TenantScope } from '../../../types.js';
import * as ledgerRepo from '../ledger.js';
import { resolveLease, listLeases } from './lease.js';

/**
 * Tenant-facing balance — §7.2/§7.3 of PLAN-PHASE3B.md.
 *
 * Runs the SAME chain-wide allocation as the landlord (`ledgerRepo.allocatedCharges`
 * / `netPaidForChain`) — the numbers must match or a tenant disputes a figure the
 * landlord cannot reproduce — but reports only over the leases the CALLER is
 * actually linked to via `lease_tenant`. `resolveLease` (portal/lease.ts) is the
 * verify-then-scope step: it returns a trusted `orgId`/`chainId` only for a lease
 * this tenant is really on, so this function never trusts a chain id a client
 * could have supplied directly (§9: "no route reads a chain id from a request").
 *
 * Takes `scope: TenantScope` first — this file lives under `db/repo/portal/` and
 * is covered by `portal-tenancy.guard.test.ts`, not the plain landlord guard.
 */
export interface PortalBalanceResult {
  leaseId: string;
  currency: string;
  asOfDate: IsoDate;
  outstandingCents: number;
  overdueCents: number;
  depositOutstandingCents: number;
  creditCents: number;
  nextDueDate: IsoDate | null;
  nextDueAmountCents: number;
}

export async function portalBalanceForLease(
  scope: TenantScope,
  db: Database,
  leaseId: string,
  asOfDate: IsoDate,
): Promise<PortalBalanceResult | null> {
  const resolved = await resolveLease(scope, db, leaseId);
  if (!resolved) return null;

  const orgId = resolved.orgId;
  const chainId = resolved.chainId;

  // Every lease in the chain the CALLER is linked to (current or former —
  // §5.6/§7.3: a departed roommate still settles against the same chain).
  // `listLeases` is `resolveLease`'s own sibling — the verified `scope.pairs`
  // filter, never a bare org filter — so this never trusts anything but what the
  // tenant is actually linked to.
  const myLeaseIds = new Set(
    (await listLeases(scope, db)).filter((l) => l.orgId === orgId && l.chainId === chainId).map((l) => l.id),
  );

  const [allCharges, netReceivedCents, chainLeases] = await Promise.all([
    ledgerRepo.allocatedCharges(orgId, db, { chainId }),
    ledgerRepo.netPaidForChain(orgId, db, chainId),
    ledgerRepo.scopedLeases(orgId, db, { chainId }),
  ]);

  // §7.3: for the common case (one tenant, renewed once or twice) `myLeaseIds`
  // IS the whole chain and this filter is a no-op. For a departed roommate it is
  // a PREFIX — they see their own lease settle when the remaining tenant pays,
  // never a debt the landlord considers cleared.
  const myCharges = allCharges.filter((c) => myLeaseIds.has(c.leaseId));

  let outstandingCents = 0;
  let overdueCents = 0;
  let depositOutstandingCents = 0;
  let nextDueDate: IsoDate | null = null;
  let nextDueAmountCents = 0;

  for (const c of myCharges) {
    if (c.voidedAt !== null) continue;
    const remainder = c.amountCents - c.appliedCents;
    outstandingCents += remainder;
    if (c.type === 'deposit') {
      depositOutstandingCents += remainder;
      continue;
    }
    if (remainder <= 0) continue;
    if (chargeOverdue(c.dueDate, asOfDate)) {
      overdueCents += remainder;
    } else if (
      compareIsoDate(c.dueDate, asOfDate) >= 0 &&
      (nextDueDate === null || compareIsoDate(c.dueDate, nextDueDate) < 0)
    ) {
      nextDueDate = c.dueDate;
      nextDueAmountCents = remainder;
    }
  }

  // §7.3: a credit is reported only when the caller is linked to the chain's
  // LATEST lease — a credit belongs to whoever is still renting, and surfacing a
  // later tenancy's credit to a departed tenant is an information leak with no
  // upside.
  let latestLeaseId = chainLeases[0]?.id ?? null;
  let latestStart = chainLeases[0]?.startDate ?? null;
  for (const l of chainLeases) {
    if (latestStart === null || compareIsoDate(l.startDate, latestStart) > 0) {
      latestStart = l.startDate;
      latestLeaseId = l.id;
    }
  }
  const isOnLatestLease = latestLeaseId !== null && myLeaseIds.has(latestLeaseId);

  const chargedCents = allCharges
    .filter((c) => c.voidedAt === null)
    .reduce((sum, c) => sum + c.amountCents, 0);
  const chainCreditCents = Math.max(0, netReceivedCents - chargedCents);

  return {
    leaseId,
    currency: resolved.currency,
    asOfDate,
    outstandingCents,
    overdueCents,
    depositOutstandingCents,
    creditCents: isOnLatestLease ? chainCreditCents : 0,
    nextDueDate,
    nextDueAmountCents: nextDueDate === null ? 0 : nextDueAmountCents,
  };
}
