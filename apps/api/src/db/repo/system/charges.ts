import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { RentStep } from '@rms/contract';
import type { Database } from '../../index.js';
import { lease, unit, property, leaseRentStep } from '../../schema.js';
import type { GeneratableLease } from '../charge.js';

/**
 * The ONE cross-org query in this phase, and it writes nothing (PLAN-PHASE3A.md
 * §6). The cron is cross-org by nature — it must scan every org's leases — but
 * everything that WRITES money stays under the ordinary `orgId`-first rule:
 * `generateChargesForLease` (repo/charge.ts) takes the `orgId` THIS function
 * returned on each row, never anything else.
 *
 * Only `jobs/*.ts` may import this module — see `system-repo.guard.test.ts`'s
 * import-graph check. A route may not: if the generator lived here, the manual
 * kick (`POST /leases/:id/charges/generate`) would need a duplicate implementation
 * or the import rule would need an exemption, and an exemption list is how a rule
 * like this gets hollowed out.
 *
 * BLOCKING FIX (review, 2026-10-09): the rent ladder is folded into THIS SAME
 * SELECT, not fetched by a second per-lease query from `jobs/daily.ts`. Two
 * reasons, both load-bearing:
 *
 * 1. Subrequest budget. Every Neon HTTP query from a Worker is a subrequest.
 *    `startRun` + this scan + ONE statement per lease (the insert) + `finishRun`
 *    is `N + 3`. A second per-lease SELECT for the ladder makes it `2N + 3` —
 *    on the Workers FREE plan's subrequest ceiling that roughly HALVES how many
 *    leases one run can reach, and the leases past the limit throw "Too many
 *    subrequests", are caught by the per-lease try/catch, and are silently never
 *    billed — every day, with the health endpoint still reporting `ok`. That is
 *    exactly the failure PLAN-PHASE2 §9 names: rent that is never charged is not
 *    a bug anyone reports.
 * 2. A lease edit landing between two separate queries (the terms SELECT, then
 *    the ladder SELECT) could write a charge from HALF the old terms and HALF
 *    the new ladder — a billingDay that drives `dueDate` from one moment in
 *    time, a ladder that drives `amountCents` from a later one. That combination
 *    existed at no point in real time, and once written it is frozen forever.
 *    One SELECT reads both from the same Postgres snapshot, so this is
 *    unreachable by construction.
 */

export interface GeneratableLeaseRow extends GeneratableLease {
  orgId: string;
  /** `localToday` needs this — the cron's only clock read is "what day is it, in
   *  THIS property's zone", never the server's. */
  propertyTimezone: string;
  /** The stored ladder, ascending by `effectiveFrom` (I20's own order) — folded
   *  into this query rather than a second one; see the module comment above. */
  rentSteps: RentStep[];
}

/**
 * One correlated subquery, aggregated as JSON inside the SAME statement as the
 * lease's own columns — not a second round trip. `coalesce(..., '[]')` so a
 * lease with no escalation (the common case) gets an empty array, never NULL.
 */
function rentStepsColumn() {
  return sql<RentStep[]>`(
    select coalesce(
      json_agg(
        json_build_object('effectiveFrom', ${leaseRentStep.effectiveFrom}, 'rentCents', ${leaseRentStep.rentCents})
        order by ${leaseRentStep.effectiveFrom}
      ),
      '[]'::json
    )
    from ${leaseRentStep}
    where ${leaseRentStep.leaseId} = ${lease.id}
  )`;
}

/**
 * THE driving scan (PLAN-PHASE3A.md §3.3). `status IN ('active','ended',
 * 'terminated')`, NOT `'active'` alone — `endLease` flips status immediately even
 * when `endDate` is months away, so an `active`-only scan would silently never bill
 * the remaining months of a lease ended in advance. `buildSchedule`'s own
 * `effectiveBillingEnd` is what actually terminates generation for an ended lease;
 * the status here only decides which leases are still worth asking.
 *
 * Excluded: `draft` (never billed anything) and `cancelled` (never will be).
 *
 * No date floor on the scan — PLAN-PHASE3A.md §3.3: that would be date arithmetic
 * in SQL to save a sequential scan over a few thousand rows at this scale (tens of
 * landlords, hundreds of leases). If it ever matters, the fix is a `lease_id >
 * cursor` loop, not an interval predicate.
 */
export async function listLeasesForGeneration(db: Database): Promise<GeneratableLeaseRow[]> {
  return db
    .select({
      id: lease.id,
      orgId: lease.orgId,
      currency: lease.currency,
      rentFrequency: lease.rentFrequency,
      rentCents: lease.rentCents,
      billingDay: lease.billingDay,
      startDate: lease.startDate,
      endDate: lease.endDate,
      ledgerStartDate: lease.ledgerStartDate,
      moveOutDate: lease.moveOutDate,
      moveOutBillingPolicy: property.moveOutBillingPolicy,
      calendar: property.calendar,
      depositCents: lease.depositCents,
      openingBalanceCents: lease.openingBalanceCents,
      propertyTimezone: property.timezone,
      rentSteps: rentStepsColumn(),
    })
    .from(lease)
    .innerJoin(unit, eq(unit.id, lease.unitId))
    .innerJoin(property, eq(property.id, unit.propertyId))
    .where(and(inArray(lease.status, ['active', 'ended', 'terminated']), isNull(lease.deletedAt)));
}
