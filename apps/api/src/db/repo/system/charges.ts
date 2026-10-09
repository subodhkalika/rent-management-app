import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../index.js';
import { lease, unit, property } from '../../schema.js';
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
 */

export interface GeneratableLeaseRow extends GeneratableLease {
  orgId: string;
  /** `localToday` needs this — the cron's only clock read is "what day is it, in
   *  THIS property's zone", never the server's. */
  propertyTimezone: string;
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
    })
    .from(lease)
    .innerJoin(unit, eq(unit.id, lease.unitId))
    .innerJoin(property, eq(property.id, unit.propertyId))
    .where(and(inArray(lease.status, ['active', 'ended', 'terminated']), isNull(lease.deletedAt)));
}
