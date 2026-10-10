import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { uuidv7, generatorFixtures, chargesThroughNextPeriod, localToday } from '@rms/contract';
import { createDb, type Database } from '../index.js';
import { organization, user, property, unit, tenant, lease, leaseTenant, leaseRentStepCorrection, charge, payment } from '../schema.js';
import { ApiException } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import * as leaseRepo from './lease.js';
import * as unitRepo from './unit.js';
import * as propertyRepo from './property.js';
import * as tenantRepo from './tenant.js';
import * as chargeRepo from './charge.js';

/**
 * REAL orchestration-function tests, against a REAL Postgres.
 *
 * The review that prompted this file (PLAN-PHASE2.md's reviewer, 2026-10-05)
 * found that every orchestration-function test in this repo mocked `lease.js`
 * itself — so a §5.2 transition test asserted an error the MOCK was told to
 * throw, never one `createLease`/`activateLease`/etc. actually produced. Deleting
 * the real `resolveTenantIds` count check at the time didn't fail a single test.
 * `lease.test.ts` only ever drove the `*Query` BUILDERS via `.toSQL()` — never the
 * orchestrating `async function`s that call them, branch on their results, and
 * decide which error to throw.
 *
 * This file drives the real exported functions against a real database instead of
 * a mock of them, so a deleted guard clause, a dropped `await`, or a wrong
 * branch fails HERE, not just "the mock still returns what I told it to".
 *
 * `lease.test.ts` is NOT redundant with this file: it still proves every `*Query`
 * builder's WHERE/SET clause is shaped correctly (the cross-org filter is really
 * in the SQL), which `.toSQL()` checks faster and without a database. This file
 * proves the ORCHESTRATION around those queries — branching, error selection,
 * write ordering, and real constraint violations (`lease_unit_active_uq`,
 * `lease_moveout_ck`, `lease_tenant_ck`) — is correct. Together they are the
 * proof the review found missing; neither alone is enough.
 *
 * SKIPPED ENTIRELY when `DATABASE_URL` is unset — e.g. in CI today, which runs no
 * Postgres service. `pnpm test` stays green everywhere. To run this file for
 * real: point `DATABASE_URL` (and `NEON_LOCAL_FETCH_ENDPOINT`, since
 * `db/index.ts`'s driver speaks HTTP, not raw TCP — see its own comment) at a
 * reachable Postgres. The simplest way, with this repo's `docker-compose.yml`
 * stack already up, run `pnpm --filter api test:live` from the repo root.
 *
 * Use that script rather than hand-writing the command. `docker compose exec`
 * WITHOUT `-T` tries to allocate a TTY, and from a non-interactive shell it hangs
 * forever at zero CPU with no output — indistinguishable from a slow suite, and it
 * has already cost one agent forty minutes of doing nothing. The script runs from
 * INSIDE the `api` container, because the Neon HTTP proxy sidecar (`db-proxy`) is
 * deliberately not exposed to the host (see docker-compose.yml's own comment).
 *
 * NOTE for CI: `.github/workflows/ci.yml` is outside `apps/api/**` (backend-dev's
 * boundary) and today sets neither env var and runs no Postgres service, so this
 * whole file is skipped there. Making it run on every PR needs a Postgres service
 * added to that workflow — flagged upward, not something this agent can land.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('lease.ts orchestration functions — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let userId: string;
  let propertyId: string;
  let unitId: string;
  let tenantAId: string;
  let tenantBId: string;

  // A second, fully separate org — exists for exactly one purpose: holding a
  // tenant id that is real (passes an `IN (...)` lookup against SOME org) but
  // foreign to `orgId` (§7.1's cross-org roster guard).
  let otherOrgId: string;
  let foreignTenantId: string;

  const baseCreateBody = () => ({
    unitId,
    tenantIds: [tenantAId],
    primaryTenantId: tenantAId,
    startDate: '2026-01-01',
    endDate: null,
    rentCents: 100000,
    rentFrequency: 'monthly' as const,
    billingDay: 1,
    depositCents: 0,
    ledgerStartDate: undefined,
    openingBalanceCents: 0,
    notes: undefined,
    escalation: null,
  });

  beforeAll(() => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
  });

  beforeEach(async () => {
    orgId = `itest_org_${uuidv7()}`;
    userId = `itest_user_${uuidv7()}`;
    otherOrgId = `itest_org_other_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'Integration Test Org', slug: orgId });
    await db.insert(organization).values({ id: otherOrgId, name: 'Integration Test Org (other)', slug: otherOrgId });
    await db.insert(user).values({ id: userId, name: 'Integration Test User', email: `${userId}@example.test` });

    const propRow = await propertyRepo.createProperty(orgId, db, {
      name: 'Test Property',
      type: 'apartment',
      address: { line1: '1 Test St', city: 'Testville', region: 'TS', postalCode: '00000', country: 'US' },
      timezone: 'UTC',
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
    });
    propertyId = propRow.id;

    const unitRow = await unitRepo.createUnit(orgId, db, propertyId, {
      label: '1A',
      bedrooms: 1,
      bathrooms: 1,
      marketRentCents: 100000,
      currency: 'USD',
      status: 'vacant',
    });
    unitId = unitRow.id;

    const tenantA = await tenantRepo.createTenant(orgId, db, {
      firstName: 'Terry',
      lastName: 'Tenant',
      status: 'active',
    });
    tenantAId = tenantA.id;
    const tenantB = await tenantRepo.createTenant(orgId, db, {
      firstName: 'Robin',
      lastName: 'Roomie',
      status: 'active',
    });
    tenantBId = tenantB.id;

    const foreignTenant = await tenantRepo.createTenant(otherOrgId, db, {
      firstName: 'Foreign',
      lastName: 'Tenant',
      status: 'active',
    });
    foreignTenantId = foreignTenant.id;
  });

  afterEach(async () => {
    for (const orgToClean of [orgId, otherOrgId]) {
      await db.delete(leaseTenant).where(eq(leaseTenant.orgId, orgToClean));
      // `lease_rent_step_correction` FKs `lease_id` with `on delete restrict` —
      // deliberately, per schema.ts's own comment: a correction is a permanent
      // financial record that must outlive the ordinary lease lifecycle. The
      // test teardown has to respect that same constraint `correctRentStep`'s
      // own tests now exercise. `lease_rent_step` itself cascades, so it needs
      // no explicit delete here, but it is harmless to be explicit about it.
      await db.delete(leaseRentStepCorrection).where(eq(leaseRentStepCorrection.orgId, orgToClean));
      // `charge.lease_id` is ON DELETE RESTRICT (schema.ts's own comment: a charge
      // is a permanent financial record and must outlive any lease-deletion path)
      // — activate/end now run the generator synchronously (PLAN-PHASE3A.md §3.2),
      // so a real test lease can genuinely have charge rows by the time teardown
      // runs, and deleting `lease` before these would itself hit the same
      // constraint the §3.5 precondition test is specifically proving.
      await db.delete(charge).where(eq(charge.orgId, orgToClean));
      // `payment.lease_id` is ON DELETE RESTRICT too (PLAN-PHASE3B.md §2.2) —
      // same reasoning, same ordering requirement as `charge` above.
      await db.delete(payment).where(eq(payment.orgId, orgToClean));
      await db.delete(lease).where(eq(lease.orgId, orgToClean));
      await db.delete(unit).where(eq(unit.orgId, orgToClean));
      await db.delete(property).where(eq(property.orgId, orgToClean));
      await db.delete(tenant).where(eq(tenant.orgId, orgToClean));
      await db.delete(organization).where(eq(organization.id, orgToClean));
    }
    await db.delete(user).where(eq(user.id, userId));
  });

  /* ======================================================================== *
   * resolveTenantIds — the dangling comment's actual subject
   * ======================================================================== */

  describe('resolveTenantIds', () => {
    it('resolves only the ids that belong to this org, silently dropping a foreign one — the caller compares lengths', async () => {
      const resolved = await leaseRepo.resolveTenantIds(orgId, db, [tenantAId, foreignTenantId]);
      expect(resolved).toEqual([tenantAId]);
      expect(resolved.length).not.toBe(2); // the short result IS the signal
    });

    it('resolves nothing for an org holding none of the requested ids', async () => {
      const resolved = await leaseRepo.resolveTenantIds(otherOrgId, db, [tenantAId, tenantBId]);
      expect(resolved).toEqual([]);
    });
  });

  /* ======================================================================== *
   * createLease — §7.1's roster-insert guard, for real
   * ======================================================================== */

  describe('createLease', () => {
    it('creates a draft lease with the live roster inserted, primary flag correct', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, {
        ...baseCreateBody(),
        tenantIds: [tenantAId, tenantBId],
        primaryTenantId: tenantBId,
      });

      expect(created.status).toBe('draft');
      expect(created.chainId).toBe(created.id);
      expect(created.tenantCount).toBe(2);
      expect(created.primaryTenantName).toBe('Robin Roomie');

      const roster = await leaseRepo.listLeaseTenants(orgId, db, created.id);
      expect(roster.map((r) => r.tenantId).sort()).toEqual([tenantAId, tenantBId].sort());
      expect(roster.find((r) => r.tenantId === tenantBId)?.isPrimary).toBe(true);
      expect(roster.find((r) => r.tenantId === tenantAId)?.isPrimary).toBe(false);
    });

    it('THE §7.1 roster-insert guard: a foreign tenant id 404s and writes NOTHING — not a partial roster, not a lease row', async () => {
      await expect(
        leaseRepo.createLease(orgId, db, userId, {
          ...baseCreateBody(),
          tenantIds: [tenantAId, foreignTenantId],
          primaryTenantId: tenantAId,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });

      // Deleting the real resolve-and-count check at lease.ts would make this
      // insert the foreign tenant onto a lease anyway — assert the INSERT never
      // happened, not just that something threw.
      const [row] = await db.select({ count: lease.id }).from(lease).where(eq(lease.orgId, orgId));
      expect(row).toBeUndefined(); // zero lease rows for this org at all
    });

    it('a unit from another org 404s (never reaches the roster check)', async () => {
      await expect(
        leaseRepo.createLease(orgId, db, userId, { ...baseCreateBody(), unitId: '00000000-0000-7000-8000-0000000000ff' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  /* ======================================================================== *
   * activateLease
   * ======================================================================== */

  describe('activateLease', () => {
    it('draft -> active, and unit.status flips to occupied', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      const activated = await leaseRepo.activateLease(orgId, db, created.id);
      expect(activated?.status).toBe('active');

      const unitRow = await unitRepo.getUnit(orgId, db, unitId);
      expect(unitRow?.status).toBe('occupied');
    });

    it('activating a non-draft lease 409s with the exact message', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);

      await expect(leaseRepo.activateLease(orgId, db, created.id)).rejects.toMatchObject({
        code: 'conflict',
        message: 'Only a draft lease can be activated.',
      });
    });

    it('activating onto a unit that already has an active lease 409s (the pre-check path)', async () => {
      const lease1 = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, lease1.id);

      const lease2 = await leaseRepo.createLease(orgId, db, userId, { ...baseCreateBody(), startDate: '2027-01-01' });
      await expect(leaseRepo.activateLease(orgId, db, lease2.id)).rejects.toMatchObject({
        code: 'conflict',
        message: 'This unit already has an active lease. End the current lease before starting a new one.',
      });
    });

    it('activating a lease with no tenants 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, { ...baseCreateBody(), tenantIds: [] });
      await expect(leaseRepo.activateLease(orgId, db, created.id)).rejects.toMatchObject({
        code: 'conflict',
        message: 'Add at least one tenant and mark one as primary before activating.',
      });
    });

    it('activating a lease on an unavailable unit 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await unitRepo.updateUnit(orgId, db, unitId, { status: 'unavailable' });
      await expect(leaseRepo.activateLease(orgId, db, created.id)).rejects.toMatchObject({
        code: 'conflict',
        message: 'This unit is marked unavailable. Change its status before activating a lease.',
      });
    });

    /**
     * THE §8.1 item 9 requirement, literally: `lease_unit_active_uq` firing on a
     * real double-activate. Bypasses `activateLease`'s own pre-check entirely —
     * two RAW concurrent UPDATEs against the same partial unique index — so this
     * proves the DATABASE CONSTRAINT itself rejects the second one, independent
     * of any application-level guard, and that `isUniqueViolation` recognises the
     * real driver's error shape (not a synthetic one — see db-errors.test.ts for
     * that half).
     */
    it('lease_unit_active_uq rejects a second concurrent activate at the database level', async () => {
      const lease1 = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      const lease2 = await leaseRepo.createLease(orgId, db, userId, { ...baseCreateBody(), startDate: '2027-01-01' });

      const rawActivate = (id: string) =>
        db
          .update(lease)
          .set({ status: 'active' })
          .where(and(eq(lease.orgId, orgId), eq(lease.id, id), eq(lease.status, 'draft')))
          .returning({ id: lease.id });

      const results = await Promise.allSettled([rawActivate(lease1.id), rawActivate(lease2.id)]);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ id: string }[]> => r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(isUniqueViolation(rejected[0]!.reason)).toBe(true);

      // And `activateLease`'s own catch converts exactly this shape of error —
      // prove it end to end on a THIRD draft lease colliding with whichever of
      // the two above won (the winner is now the unit's active lease).
      const lease3 = await leaseRepo.createLease(orgId, db, userId, { ...baseCreateBody(), startDate: '2028-01-01' });
      await expect(leaseRepo.activateLease(orgId, db, lease3.id)).rejects.toMatchObject({
        code: 'conflict',
        message: 'This unit already has an active lease. End the current lease before starting a new one.',
      });
    });
  });

  /* ======================================================================== *
   * endLease — BLOCKING 2's moveOutDate half
   * ======================================================================== */

  describe('endLease', () => {
    it('active -> ended, unit.status flips to vacant', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);

      const ended = await leaseRepo.endLease(orgId, db, created.id, {
        endDate: '2026-06-30',
        reason: 'term_ended',
      });
      expect(ended?.status).toBe('ended');

      const unitRow = await unitRepo.getUnit(orgId, db, unitId);
      expect(unitRow?.status).toBe('vacant');
    });

    it('breach/eviction reasons end as terminated', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);
      const ended = await leaseRepo.endLease(orgId, db, created.id, { endDate: '2026-06-30', reason: 'breach' });
      expect(ended?.status).toBe('terminated');
    });

    it('ending a draft lease 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await expect(
        leaseRepo.endLease(orgId, db, created.id, { endDate: '2026-06-30', reason: 'term_ended' }),
      ).rejects.toMatchObject({ code: 'conflict', message: 'Activate the lease first, or cancel it.' });
    });

    it('ending an already-ended lease 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);
      await leaseRepo.endLease(orgId, db, created.id, { endDate: '2026-06-30', reason: 'term_ended' });
      await expect(
        leaseRepo.endLease(orgId, db, created.id, { endDate: '2026-07-30', reason: 'term_ended' }),
      ).rejects.toMatchObject({ code: 'conflict', message: 'This lease has already ended.' });
    });

    /**
     * BLOCKING 2: `lease_moveout_ck` is `move_out_date IS NULL OR move_out_date
     * >= start_date`. Before the fix, `endLease` wrote this unvalidated — SQLSTATE
     * 23514, which `db-errors.ts` does not recognise, bubbling up as an unhandled
     * 500 while the lease stayed active. Proves the FIX: a 422 `ApiException`,
     * never a raw driver error, and the lease is untouched (still active).
     */
    it('a moveOutDate before the lease started 422s instead of 500ing on lease_moveout_ck, and the lease is untouched', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, { ...baseCreateBody(), startDate: '2026-01-01' });
      await leaseRepo.activateLease(orgId, db, created.id);

      let caught: unknown;
      try {
        await leaseRepo.endLease(orgId, db, created.id, {
          endDate: '2026-06-30',
          moveOutDate: '2025-12-01', // before start_date — violates lease_moveout_ck
          reason: 'term_ended',
        });
        expect.unreachable('expected endLease to reject');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ApiException);
      expect((caught as ApiException).code).toBe('validation_failed');

      const stillActive = await leaseRepo.getLease(orgId, db, created.id);
      expect(stillActive?.status).toBe('active');
      expect(stillActive?.endDate).toBeNull();
    });

    /**
     * THE §3.3 under-billing fix, proven at the generator level (the driving
     * SCAN itself — status IN ('active','ended','terminated') — is proven
     * directly in db/repo/system/charges.integration.test.ts). A lease ended
     * today, effective many months out, flips to `ended` IMMEDIATELY — there is
     * no "pending end" state. Before this phase, an `active`-only scan would
     * have silently stopped billing it the moment it left `active`, even though
     * the term — and the rent — continues for months. This asserts the
     * generator keeps producing rent charges for an ENDED lease with a future
     * endDate, exactly as it would for an active one.
     */
    it('a future endDate still bills the remaining months — the generator keeps writing for an ENDED lease', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, { ...baseCreateBody(), startDate: '2026-01-01' });
      await leaseRepo.activateLease(orgId, db, created.id);

      const ended = await leaseRepo.endLease(orgId, db, created.id, { endDate: '2027-06-30', reason: 'term_ended' });
      expect(ended?.status).toBe('ended');

      const afterEnd = await db.select().from(charge).where(eq(charge.leaseId, created.id));
      const rentRowsAfterEnd = afterEnd.filter((r) => r.type === 'rent');
      expect(rentRowsAfterEnd.length).toBeGreaterThan(0); // the synchronous call (§3.2) wrote something already

      // Simulate a much-later cron run, directly — `generateChargesForLease`
      // itself never reads `status`; the whole point of the fix is that this
      // ENDED lease is still HANDED to it by the driving scan.
      const rentSteps = leaseRepo.toRentSteps(await leaseRepo.listRentSteps(orgId, db, created.id));
      const laterRow = (await leaseRepo.getLease(orgId, db, created.id))!;
      const more = await chargeRepo.generateChargesForLease(orgId, db, laterRow, rentSteps, '2026-12-01');
      expect(more.length).toBeGreaterThan(0); // further months get written — nothing stopped it

      const final = await db.select().from(charge).where(eq(charge.leaseId, created.id));
      const december = final.find((r) => r.type === 'rent' && r.periodStart === '2026-12-01');
      expect(december).toBeDefined();
    });
  });

  /* ======================================================================== *
   * renewLease
   * ======================================================================== */

  describe('renewLease', () => {
    it('active predecessor: ends the predecessor, creates an active successor in the same chain, carries the live roster', async () => {
      const predecessor = await leaseRepo.createLease(orgId, db, userId, {
        ...baseCreateBody(),
        tenantIds: [tenantAId, tenantBId],
        primaryTenantId: tenantAId,
      });
      await leaseRepo.activateLease(orgId, db, predecessor.id);

      const renewed = await leaseRepo.renewLease(orgId, db, userId, predecessor.id, {
        startDate: '2027-01-01',
        rentCents: 110000,
      });

      expect(renewed?.status).toBe('active');
      expect(renewed?.chainId).toBe(predecessor.chainId);
      expect(renewed?.renewedFromLeaseId).toBe(predecessor.id);
      expect(renewed?.tenantCount).toBe(2);

      const predecessorAfter = await leaseRepo.getLease(orgId, db, predecessor.id);
      expect(predecessorAfter?.status).toBe('ended');
      expect(predecessorAfter?.endDate).toBe('2026-12-31');
    });

    it('ended predecessor: a gap is allowed', async () => {
      const predecessor = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, predecessor.id);
      await leaseRepo.endLease(orgId, db, predecessor.id, { endDate: '2026-06-30', reason: 'term_ended' });

      const renewed = await leaseRepo.renewLease(orgId, db, userId, predecessor.id, {
        startDate: '2026-09-01', // a two-month gap
        rentCents: 100000,
      });
      expect(renewed?.status).toBe('active');
    });

    it('an overlapping renewal 409s', async () => {
      const predecessor = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, predecessor.id);

      await expect(
        leaseRepo.renewLease(orgId, db, userId, predecessor.id, { startDate: '2026-01-01', rentCents: 100000 }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('renewing a draft lease 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await expect(
        leaseRepo.renewLease(orgId, db, userId, created.id, { startDate: '2027-01-01', rentCents: 100000 }),
      ).rejects.toMatchObject({ code: 'conflict', message: 'Only an active or ended lease can be renewed.' });
    });

    /**
     * PLAN-PHASE3B.md §13: `chain_id` must mean "one tenancy" BY CONSTRUCTION —
     * chain-wide FIFO allocation (repo/ledger.ts) depends on it. A "renewal"
     * sharing no tenant with the predecessor is a brand-new tenancy; it must be
     * a new lease (a new chain), not a renewal reusing the old one. This is the
     * Phase 2 behaviour change the Phase 3b plan calls for.
     */
    it('a renewal sharing no tenant with the predecessor 409s — carrying forward a disjoint roster', async () => {
      const predecessor = await leaseRepo.createLease(orgId, db, userId, baseCreateBody()); // tenantAId only
      await leaseRepo.activateLease(orgId, db, predecessor.id);

      // A brand new tenant, never on the predecessor's roster at all.
      const strangerId = (
        await tenantRepo.createTenant(orgId, db, { firstName: 'Stranger', lastName: 'Danger', status: 'prospect' })
      ).id;

      await expect(
        leaseRepo.renewLease(orgId, db, userId, predecessor.id, {
          startDate: '2027-01-01',
          rentCents: 100000,
          carryTenantIds: [strangerId],
          primaryTenantId: strangerId,
        }),
      ).rejects.toMatchObject({
        code: 'conflict',
        message: 'A renewal must carry forward at least one tenant from the current lease. Start a new lease instead.',
      });

      // Untouched, not torn: the predecessor stays active, no successor exists.
      const stillActive = await leaseRepo.getLease(orgId, db, predecessor.id);
      expect(stillActive?.status).toBe('active');
    });

    it('a renewal carrying forward AT LEAST ONE shared tenant succeeds, even if the rest of the roster changes', async () => {
      const predecessor = await leaseRepo.createLease(orgId, db, userId, {
        ...baseCreateBody(),
        tenantIds: [tenantAId, tenantBId],
        primaryTenantId: tenantAId,
      });
      await leaseRepo.activateLease(orgId, db, predecessor.id);

      const strangerId = (
        await tenantRepo.createTenant(orgId, db, { firstName: 'New', lastName: 'Roommate', status: 'prospect' })
      ).id;

      // tenantBId carries forward; tenantAId leaves, strangerId joins — one
      // shared tenant is enough for this to read as the same tenancy.
      const renewed = await leaseRepo.renewLease(orgId, db, userId, predecessor.id, {
        startDate: '2027-01-01',
        rentCents: 110000,
        carryTenantIds: [tenantBId, strangerId],
        primaryTenantId: tenantBId,
      });
      expect(renewed?.status).toBe('active');
      expect(renewed?.chainId).toBe(predecessor.chainId);
      expect(renewed?.tenantCount).toBe(2);
    });

    it('an EXPLICIT empty carryTenantIds against a predecessor with live tenants 409s', async () => {
      const predecessor = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, predecessor.id);

      await expect(
        leaseRepo.renewLease(orgId, db, userId, predecessor.id, {
          startDate: '2027-01-01',
          rentCents: 100000,
          carryTenantIds: [],
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    /**
     * MINOR 1: an onboarded predecessor's `ledgerStartDate` can sit after its
     * `startDate`. `predecessorEnd = newStart - 1` can then land BEFORE that
     * ledger start, violating `lease_ledger_ck` (`ledger_start_date <=
     * end_date`). Proves the fix: 409, not a 500, and the predecessor stays active.
     */
    it('a renewal that would end the predecessor before its own ledger start 409s instead of 500ing on lease_ledger_ck', async () => {
      const id = uuidv7();
      // Raw insert: an onboarded lease whose ledger starts a month after it did —
      // createLease's own validateBillingTerms would reject ledgerStartDate unless
      // it is a period start; 2026-02-01 is a monthly period start, so this is a
      // legitimate in-flight-tenancy lease (PLAN-PHASE2.md F9's shape).
      await db.insert(lease).values({
        id,
        orgId,
        unitId,
        chainId: id,
        startDate: '2026-01-01',
        ledgerStartDate: '2026-02-01',
        rentCents: 100000,
        currency: 'USD',
        rentFrequency: 'monthly',
        billingDay: 1,
        status: 'active',
        createdByUserId: userId,
      });
      // renewLease's roster/primary resolution runs BEFORE the ledger-start
      // check — give the raw-inserted predecessor a live, primaried roster so
      // the call reaches the check this test actually exercises, rather than
      // failing earlier on "no primary tenant to carry".
      await db.insert(leaseTenant).values({
        id: uuidv7(),
        orgId,
        leaseId: id,
        tenantId: tenantAId,
        isPrimary: true,
        addedOn: '2026-01-01',
      });

      await expect(
        leaseRepo.renewLease(orgId, db, userId, id, { startDate: '2026-01-15', rentCents: 100000 }),
      ).rejects.toMatchObject({ code: 'conflict' });

      const stillThere = await leaseRepo.getLease(orgId, db, id);
      expect(stillThere?.status).toBe('active'); // untouched, not torn
    });
  });

  /* ======================================================================== *
   * cancelLease / hardDeleteLease
   * ======================================================================== */

  describe('cancelLease and hardDeleteLease', () => {
    it('cancels a draft, then hard-deletes it', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      const cancelled = await leaseRepo.cancelLease(orgId, db, created.id);
      expect(cancelled?.status).toBe('cancelled');

      const result = await leaseRepo.hardDeleteLease(orgId, db, created.id);
      expect(result).toBe(true);

      const gone = await leaseRepo.getLease(orgId, db, created.id);
      expect(gone).toBeNull();
    });

    it('cancelling a non-draft lease 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);
      await expect(leaseRepo.cancelLease(orgId, db, created.id)).rejects.toMatchObject({ code: 'conflict' });
    });

    it('hard-deleting an active lease is blocked, never a silent no-op', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);
      const result = await leaseRepo.hardDeleteLease(orgId, db, created.id);
      expect(result).toBe('blocked');

      const stillThere = await leaseRepo.getLease(orgId, db, created.id);
      expect(stillThere).not.toBeNull();
    });

    /**
     * PLAN-PHASE3A.md §3.5: `charge.lease_id` is `ON DELETE RESTRICT`, so a
     * cancelled/draft lease that somehow acquired a charge row would otherwise
     * fail the soft-delete at the DATABASE with SQLSTATE 23503 — which
     * `lib/db-errors.ts` does not recognise, surfacing as an unhandled 500
     * instead of the clean 409 every other blocked case returns. A cancelled
     * lease never reaches `createManualCharge` through the ordinary route (it
     * refuses draft/cancelled), so this inserts the charge directly to prove
     * the PRECONDITION CHECK itself — not just the happy path that never
     * triggers it.
     */
    it('a cancelled lease holding a charge row (however it got one) is blocked, never 500ing on the FK', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      const cancelled = await leaseRepo.cancelLease(orgId, db, created.id);
      expect(cancelled?.status).toBe('cancelled');

      await db.insert(charge).values({
        id: uuidv7(),
        orgId,
        leaseId: created.id,
        type: 'other',
        dueDate: '2026-01-01',
        amountCents: 100,
        currency: 'USD',
        source: 'manual',
        createdByUserId: userId,
      });

      const result = await leaseRepo.hardDeleteLease(orgId, db, created.id);
      expect(result).toBe('blocked');

      const stillThere = await leaseRepo.getLease(orgId, db, created.id);
      expect(stillThere).not.toBeNull();
    });

    /**
     * PLAN-PHASE3B.md §4.13: the zero-PAYMENT half of the same precondition —
     * `payment.lease_id` is `ON DELETE RESTRICT` too. A cancelled lease never
     * reaches `recordPayment` through the ordinary route (it refuses draft/
     * cancelled, same as charges), so this inserts the payment row directly to
     * prove the PRECONDITION CHECK itself, not just the happy path.
     */
    it('a cancelled lease holding a payment row (however it got one) is blocked, never 500ing on the FK', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      const cancelled = await leaseRepo.cancelLease(orgId, db, created.id);
      expect(cancelled?.status).toBe('cancelled');

      await db.insert(payment).values({
        id: uuidv7(),
        orgId,
        leaseId: created.id,
        kind: 'payment',
        method: 'cash',
        amountCents: 100,
        currency: 'USD',
        receivedOn: '2026-01-01',
        recordedByUserId: userId,
      });

      const result = await leaseRepo.hardDeleteLease(orgId, db, created.id);
      expect(result).toBe('blocked');

      const stillThere = await leaseRepo.getLease(orgId, db, created.id);
      expect(stillThere).not.toBeNull();
    });
  });

  /* ======================================================================== *
   * roster — add / remove / set primary. BLOCKING 2's lease_tenant_ck half.
   * ======================================================================== */

  describe('addLeaseTenant / removeLeaseTenant / setPrimaryTenant', () => {
    it('adds a roommate, reassigns primary, removes the original tenant', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());

      const added = await leaseRepo.addLeaseTenant(orgId, db, created.id, { tenantId: tenantBId, isPrimary: false });
      expect(added?.tenantId).toBe(tenantBId);

      const primaried = await leaseRepo.setPrimaryTenant(orgId, db, created.id, tenantBId);
      expect(primaried?.isPrimary).toBe(true);

      const removed = await leaseRepo.removeLeaseTenant(orgId, db, created.id, tenantAId, {});
      expect(removed?.removedOn).not.toBeNull();

      const roster = await leaseRepo.listLeaseTenants(orgId, db, created.id);
      expect(roster.find((r) => r.tenantId === tenantAId)?.removedOn).not.toBeNull();
      expect(roster.find((r) => r.tenantId === tenantBId)?.isPrimary).toBe(true);
    });

    it('adding a tenant already on the lease 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await expect(
        leaseRepo.addLeaseTenant(orgId, db, created.id, { tenantId: tenantAId, isPrimary: false }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('adding a FOREIGN tenant id 404s — §7.1 applies to this route too', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await expect(
        leaseRepo.addLeaseTenant(orgId, db, created.id, { tenantId: foreignTenantId, isPrimary: false }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('adding to an ended lease 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);
      await leaseRepo.endLease(orgId, db, created.id, { endDate: '2026-06-30', reason: 'term_ended' });
      await expect(
        leaseRepo.addLeaseTenant(orgId, db, created.id, { tenantId: tenantBId, isPrimary: false }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('removing the primary without reassigning first 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await expect(leaseRepo.removeLeaseTenant(orgId, db, created.id, tenantAId, {})).rejects.toMatchObject({
        code: 'conflict',
      });
    });

    it('removing the last live tenant from an ACTIVE lease 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.addLeaseTenant(orgId, db, created.id, { tenantId: tenantBId, isPrimary: false });
      await leaseRepo.setPrimaryTenant(orgId, db, created.id, tenantBId);
      await leaseRepo.activateLease(orgId, db, created.id);
      await leaseRepo.removeLeaseTenant(orgId, db, created.id, tenantAId, {}); // fine — one tenant remains

      await expect(leaseRepo.removeLeaseTenant(orgId, db, created.id, tenantBId, {})).rejects.toMatchObject({
        code: 'conflict',
      });
    });

    /**
     * BLOCKING 2's second half: `lease_tenant_ck` is `removed_on IS NULL OR
     * removed_on >= added_on`. Before the fix, `removeLeaseTenant` wrote this
     * unvalidated. Proves the fix: 422, not 500, and the tenant is still live.
     */
    it('a removedOn before addedOn 422s instead of 500ing on lease_tenant_ck', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.addLeaseTenant(orgId, db, created.id, {
        tenantId: tenantBId,
        isPrimary: false,
        addedOn: '2026-03-01',
      });

      let caught: unknown;
      try {
        await leaseRepo.removeLeaseTenant(orgId, db, created.id, tenantBId, { removedOn: '2026-01-01' });
        expect.unreachable('expected removeLeaseTenant to reject');
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ApiException);
      expect((caught as ApiException).code).toBe('validation_failed');

      const roster = await leaseRepo.listLeaseTenants(orgId, db, created.id);
      expect(roster.find((r) => r.tenantId === tenantBId)?.removedOn).toBeNull(); // untouched
    });

    it('setting a REMOVED tenant as primary 409s', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.addLeaseTenant(orgId, db, created.id, { tenantId: tenantBId, isPrimary: false });
      await leaseRepo.removeLeaseTenant(orgId, db, created.id, tenantBId, {});

      await expect(leaseRepo.setPrimaryTenant(orgId, db, created.id, tenantBId)).rejects.toMatchObject({
        code: 'conflict',
      });
    });
  });

  /* ======================================================================== *
   * updateLease — MINOR 2: unitId revalidates against the NEW property
   * ======================================================================== */

  describe('updateLease', () => {
    it('an immutable field on an active lease 409s naming /renew', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await leaseRepo.activateLease(orgId, db, created.id);
      await expect(leaseRepo.updateLease(orgId, db, created.id, { rentCents: 999999 })).rejects.toMatchObject({
        code: 'conflict',
      });
    });

    it('moving a draft to a unit under a BIKRAM SAMBAT property revalidates against the NEW calendar, not the old one', async () => {
      const bsProperty = await propertyRepo.createProperty(orgId, db, {
        name: 'BS Property',
        type: 'apartment',
        address: { line1: '2 Test St', city: 'Testville', region: 'TS', postalCode: '00000', country: 'US' },
        timezone: 'UTC',
        moveOutBillingPolicy: 'bill_full_term',
        calendar: 'bikram_sambat',
      });
      const bsUnit = await unitRepo.createUnit(orgId, db, bsProperty.id, {
        label: 'BS1',
        bedrooms: 1,
        bathrooms: 1,
        marketRentCents: 100000,
        currency: 'USD',
        status: 'vacant',
      });

      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());

      // billingDay 32 is impossible under the Gregorian property this lease was
      // created under, but valid under Bikram Sambat. Before the fix, updateLease
      // validated against `current.calendar` (the OLD, Gregorian property) even
      // when unitId was changing — this would incorrectly reject it.
      const updated = await leaseRepo.updateLease(orgId, db, created.id, { unitId: bsUnit.id, billingDay: 32 });
      expect(updated?.unitId).toBe(bsUnit.id);
      expect(updated?.billingDay).toBe(32);
      expect(updated?.calendar).toBe('bikram_sambat');
    });

    it('moving a draft to a unit under another org 404s, never leaking the foreign unit', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      await expect(
        leaseRepo.updateLease(orgId, db, created.id, { unitId: '00000000-0000-7000-8000-0000000000ff' }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  /* ======================================================================== *
   * cross-org isolation, end to end — every orchestration function above
   * ======================================================================== */

  describe('cross-org isolation at the orchestration level', () => {
    it("org B's getLease for org A's lease id returns null, never org A's row", async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      const asOtherOrg = await leaseRepo.getLease(otherOrgId, db, created.id);
      expect(asOtherOrg).toBeNull();
    });

    it("org B's activateLease for org A's lease id returns null, never reaching lease_unit_active_uq", async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, baseCreateBody());
      const asOtherOrg = await leaseRepo.activateLease(otherOrgId, db, created.id);
      expect(asOtherOrg).toBeNull();

      // Confirm it is STILL draft under its real org — org B's call had zero effect.
      const stillDraft = await leaseRepo.getLease(orgId, db, created.id);
      expect(stillDraft?.status).toBe('draft');
    });
  });

  /* ======================================================================== *
   * rent steps — PLAN-ESCALATION.md §2.3/§4. The stored ladder the schedule
   * reads, the PUT-replaces-the-whole-ladder rule, and the one genuinely new
   * cross-org shape (§4.6): a foreign stepId resolved by (org_id, lease_id, id).
   * ======================================================================== */

  describe('rent steps', () => {
    it('createLease with a clause and no rentSteps generates the SAME ladder generateRentSteps would (byte-identical, G1)', async () => {
      const g1 = generatorFixtures.find((f) => f.name.startsWith('G1'))!;
      const created = await leaseRepo.createLease(orgId, db, userId, {
        ...baseCreateBody(),
        startDate: g1.input.startDate,
        endDate: g1.input.endDate,
        rentCents: g1.input.baseRentCents,
        rentFrequency: g1.input.frequency,
        escalation: g1.input.clause,
        // rentSteps OMITTED — the server must draft it with generateRentSteps.
      });

      const steps = await leaseRepo.listRentSteps(orgId, db, created.id);
      expect(steps.map((s) => ({ effectiveFrom: s.effectiveFrom, rentCents: s.rentCents, source: s.source, clauseExpectedCents: s.clauseExpectedCents }))).toEqual(
        g1.expected.map((s) => ({
          effectiveFrom: s.effectiveFrom,
          rentCents: s.rentCents,
          source: s.source,
          clauseExpectedCents: s.clauseExpectedCents,
        })),
      );
    });

    it('createLease with an explicit rentSteps array writes it VERBATIM, never regenerating it', async () => {
      const created = await leaseRepo.createLease(orgId, db, userId, {
        ...baseCreateBody(),
        startDate: '2020-01-01',
        escalation: null,
        rentSteps: [
          { effectiveFrom: '2020-06-01', rentCents: 110000, source: 'manual' },
          { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
        ],
      });

      const steps = await leaseRepo.listRentSteps(orgId, db, created.id);
      expect(steps.map((s) => s.effectiveFrom)).toEqual(['2020-06-01', '2030-06-01']);
      expect(steps.map((s) => s.rentCents)).toEqual([110000, 120000]);
      expect(steps.every((s) => s.source === 'manual')).toBe(true);
    });

    describe('replaceRentSteps / correctRentStep — the mutability line is "has it taken effect"', () => {
      async function createLeaseWithPastAndFutureStep() {
        return leaseRepo.createLease(orgId, db, userId, {
          ...baseCreateBody(),
          startDate: '2020-01-01',
          escalation: null,
          rentSteps: [
            // Long past "today" under any real clock this suite runs against.
            { effectiveFrom: '2020-06-01', rentCents: 110000, source: 'manual' },
            // Far enough out to stay future for a long time.
            { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
          ],
        });
      }

      // §4.5's table makes the date-based "has it taken effect" guard apply to
      // every status EXCEPT `draft` — a draft has never billed anything, so a
      // past step is exactly as free as a future one. These helpers push the
      // SAME lease through activation (and, for `ended`/`terminated`, through
      // `endLease`) so the boundary tests below exercise the real transitions,
      // not a hand-set status column.
      async function createActiveLeaseWithPastAndFutureStep() {
        const created = await createLeaseWithPastAndFutureStep();
        await leaseRepo.activateLease(orgId, db, created.id);
        return (await leaseRepo.getLease(orgId, db, created.id))!;
      }

      async function createEndedLeaseWithPastAndFutureStep(reason: 'mutual' | 'breach') {
        const created = await createLeaseWithPastAndFutureStep();
        await leaseRepo.activateLease(orgId, db, created.id);
        await leaseRepo.endLease(orgId, db, created.id, { endDate: '2031-01-01', reason });
        return (await leaseRepo.getLease(orgId, db, created.id))!;
      }

      async function createCancelledLeaseWithPastAndFutureStep() {
        const created = await createLeaseWithPastAndFutureStep();
        return (await leaseRepo.cancelLease(orgId, db, created.id))!;
      }

      it('PUT freely edits a FUTURE step, unaudited', async () => {
        const created = await createLeaseWithPastAndFutureStep();
        const existing = await leaseRepo.listRentSteps(orgId, db, created.id);

        const replaced = await leaseRepo.replaceRentSteps(orgId, db, created.id, {
          steps: [
            { effectiveFrom: '2020-06-01', rentCents: 110000, source: 'manual' },
            { effectiveFrom: '2030-06-01', rentCents: 999999, source: 'manual' },
          ],
        });

        expect(replaced?.find((s) => s.effectiveFrom === '2030-06-01')?.rentCents).toBe(999999);
        const corrections = await leaseRepo.listRentStepCorrections(orgId, db, created.id);
        expect(corrections).toEqual([]);
        expect(existing.length).toBe(2); // sanity: both steps were actually there beforehand
      });

      describe('§4.5 — a DRAFT lease has no past', () => {
        it('PUT freely REPLACES a PAST step on a draft lease, unaudited', async () => {
          const created = await createLeaseWithPastAndFutureStep();
          expect(created.status).toBe('draft');

          const replaced = await leaseRepo.replaceRentSteps(orgId, db, created.id, {
            steps: [
              { effectiveFrom: '2020-06-01', rentCents: 999999, source: 'manual' },
              { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
            ],
          });

          expect(replaced?.find((s) => s.effectiveFrom === '2020-06-01')?.rentCents).toBe(999999);
          const corrections = await leaseRepo.listRentStepCorrections(orgId, db, created.id);
          expect(corrections).toEqual([]); // nothing billed, nothing audited
        });

        it('PUT freely REMOVES a PAST step on a draft lease', async () => {
          const created = await createLeaseWithPastAndFutureStep();
          const replaced = await leaseRepo.replaceRentSteps(orgId, db, created.id, {
            steps: [{ effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' }],
          });
          expect(replaced?.map((s) => s.effectiveFrom)).toEqual(['2030-06-01']);
        });

        it('PUT freely ADDS a BACKDATED step on a draft lease — onboarding a tenancy already in progress (§4.3)', async () => {
          const created = await createLeaseWithPastAndFutureStep();
          const replaced = await leaseRepo.replaceRentSteps(orgId, db, created.id, {
            steps: [
              { effectiveFrom: '2020-06-01', rentCents: 110000, source: 'manual' },
              { effectiveFrom: '2021-06-01', rentCents: 115000, source: 'manual' },
              { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
            ],
          });
          expect(replaced?.map((s) => s.effectiveFrom)).toEqual(['2020-06-01', '2021-06-01', '2030-06-01']);
        });
      });

      describe('§4.5 — the status boundary, once a lease has a real past', () => {
        it('ACTIVE: PUT changing a PAST step still 409s — "already taken effect"', async () => {
          const created = await createActiveLeaseWithPastAndFutureStep();
          expect(created.status).toBe('active');
          await expect(
            leaseRepo.replaceRentSteps(orgId, db, created.id, {
              steps: [
                { effectiveFrom: '2020-06-01', rentCents: 999999, source: 'manual' },
                { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
              ],
            }),
          ).rejects.toMatchObject({ code: 'conflict' });
        });

        it('ACTIVE: PUT removing a PAST step still 409s — same guard', async () => {
          const created = await createActiveLeaseWithPastAndFutureStep();
          await expect(
            leaseRepo.replaceRentSteps(orgId, db, created.id, {
              steps: [{ effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' }],
            }),
          ).rejects.toMatchObject({ code: 'conflict' });
        });

        it('ACTIVE: PUT adding a BACKDATED step still 409s — "cannot be backdated"', async () => {
          const created = await createActiveLeaseWithPastAndFutureStep();
          await expect(
            leaseRepo.replaceRentSteps(orgId, db, created.id, {
              steps: [
                { effectiveFrom: '2020-06-01', rentCents: 110000, source: 'manual' },
                { effectiveFrom: '2021-06-01', rentCents: 115000, source: 'manual' },
                { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
              ],
            }),
          ).rejects.toMatchObject({ code: 'conflict' });
        });

        it('ENDED: PUT changing a PAST step still 409s — dead data, but still audited through /correct', async () => {
          const created = await createEndedLeaseWithPastAndFutureStep('mutual');
          expect(created.status).toBe('ended');
          await expect(
            leaseRepo.replaceRentSteps(orgId, db, created.id, {
              steps: [
                { effectiveFrom: '2020-06-01', rentCents: 999999, source: 'manual' },
                { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
              ],
            }),
          ).rejects.toMatchObject({ code: 'conflict' });
        });

        it('TERMINATED: PUT changing a PAST step still 409s', async () => {
          const created = await createEndedLeaseWithPastAndFutureStep('breach');
          expect(created.status).toBe('terminated');
          await expect(
            leaseRepo.replaceRentSteps(orgId, db, created.id, {
              steps: [
                { effectiveFrom: '2020-06-01', rentCents: 999999, source: 'manual' },
                { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
              ],
            }),
          ).rejects.toMatchObject({ code: 'conflict' });
        });

        it('CANCELLED: PUT 409s regardless of past or future — "A cancelled lease cannot be changed."', async () => {
          const created = await createCancelledLeaseWithPastAndFutureStep();
          expect(created.status).toBe('cancelled');
          await expect(
            leaseRepo.replaceRentSteps(orgId, db, created.id, {
              steps: [{ effectiveFrom: '2030-06-01', rentCents: 999999, source: 'manual' }],
            }),
          ).rejects.toMatchObject({ code: 'conflict', message: 'A cancelled lease cannot be changed.' });
        });
      });

      /**
       * PLAN-PHASE3A.md §3.4 — THE new behaviour this phase introduces.
       *
       * Rewritten 2026-10-09 (the "charges a month ahead by default" fix):
       * `GENERATION_LOOKAHEAD_DAYS` is now 0, so the synchronous generation
       * `activateLease` runs no longer reaches a future period by itself — only
       * the period CONTAINING `today` gets written. Reaching "the 1st of next
       * calendar month" is now a DELIBERATE act (`chargesThroughNextPeriod`, the
       * landlord billing one period early on purpose), never an automatic side
       * effect of activation. This test now proves both halves: the step is
       * freely editable by PUT right after activation (nothing has billed it
       * yet), and becomes PUT-refused / `/correct`-accepted only once the
       * landlord explicitly bills that next period.
       */
      it('§3.4: a step in the next period is free to PUT until billed early, then refused by PUT and accepted by /correct — and the complement, far beyond it', async () => {
        const now = new Date();
        const nextPeriodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
          .toISOString()
          .slice(0, 10);
        const farFuture = '2099-01-01'; // unambiguously beyond any real horizon

        const created = await leaseRepo.createLease(orgId, db, userId, {
          ...baseCreateBody(),
          startDate: '2020-01-01',
          escalation: null,
          rentSteps: [
            { effectiveFrom: nextPeriodStart, rentCents: 160000, source: 'manual' },
            { effectiveFrom: farFuture, rentCents: 170000, source: 'manual' },
          ],
        });
        await leaseRepo.activateLease(orgId, db, created.id);

        // Confirm the premise: activation's ordinary (lookahead-0) generation did
        // NOT reach the next period — it only ever writes through the period
        // containing `today`.
        const latestAfterActivation = await chargeRepo.latestChargedPeriodStart(orgId, db, created.id);
        expect(latestAfterActivation).not.toBeNull();
        expect(latestAfterActivation! < nextPeriodStart).toBe(true);

        // So PUT freely accepts editing the next-period step too — nothing has
        // billed it yet.
        const replacedEarly = await leaseRepo.replaceRentSteps(orgId, db, created.id, {
          steps: [
            { effectiveFrom: nextPeriodStart, rentCents: 161000, source: 'manual' },
            { effectiveFrom: farFuture, rentCents: 170000, source: 'manual' },
          ],
        });
        expect(replacedEarly?.find((s) => s.effectiveFrom === nextPeriodStart)?.rentCents).toBe(161000);

        // Now the landlord deliberately bills one period early.
        const leaseRow = (await leaseRepo.getLease(orgId, db, created.id))!;
        const rentSteps = leaseRepo.toRentSteps(await leaseRepo.listRentSteps(orgId, db, created.id));
        const today = localToday(leaseRow.propertyTimezone);
        await chargeRepo.generateChargesForLease(orgId, db, leaseRow, rentSteps, today, chargesThroughNextPeriod);

        const latest = await chargeRepo.latestChargedPeriodStart(orgId, db, created.id);
        expect(latest).not.toBeNull();
        expect(latest! >= nextPeriodStart).toBe(true);

        // PUT now refuses the next-period step — "already billed".
        await expect(
          leaseRepo.replaceRentSteps(orgId, db, created.id, {
            steps: [
              { effectiveFrom: nextPeriodStart, rentCents: 999999, source: 'manual' },
              { effectiveFrom: farFuture, rentCents: 170000, source: 'manual' },
            ],
          }),
        ).rejects.toMatchObject({ code: 'conflict' });

        // ...but PUT still freely accepts editing the far-future step, unaudited.
        const replaced = await leaseRepo.replaceRentSteps(orgId, db, created.id, {
          steps: [
            { effectiveFrom: nextPeriodStart, rentCents: 161000, source: 'manual' },
            { effectiveFrom: farFuture, rentCents: 999999, source: 'manual' },
          ],
        });
        expect(replaced?.find((s) => s.effectiveFrom === farFuture)?.rentCents).toBe(999999);

        // /correct is the EXACT complement: it accepts the now-billed next-period
        // step...
        const steps = await leaseRepo.listRentSteps(orgId, db, created.id);
        const withinStep = steps.find((s) => s.effectiveFrom === nextPeriodStart)!;
        const corrected = await leaseRepo.correctRentStep(orgId, db, created.id, withinStep.id, userId, {
          rentCents: 165000,
          reason: 'Correction after billing the next period early, exercising the §3.4 boundary.',
        });
        expect(corrected?.rentCents).toBe(165000);

        // ...and refuses the far-future one — "has not taken effect yet".
        const farStep = steps.find((s) => s.effectiveFrom === farFuture)!;
        await expect(
          leaseRepo.correctRentStep(orgId, db, created.id, farStep.id, userId, {
            rentCents: 1,
            reason: 'Should 409 — this step has not taken effect yet.',
          }),
        ).rejects.toMatchObject({ code: 'conflict' });
      });

      it('PUT with an out-of-order effectiveFrom 422s (I20, via validateBillingTerms)', async () => {
        const created = await createLeaseWithPastAndFutureStep();
        await expect(
          leaseRepo.replaceRentSteps(orgId, db, created.id, {
            steps: [
              { effectiveFrom: '2030-06-01', rentCents: 120000, source: 'manual' },
              { effectiveFrom: '2020-06-01', rentCents: 110000, source: 'manual' },
            ],
          }),
        ).rejects.toMatchObject({ code: 'validation_failed' });
      });

      it('correctRentStep on a PAST step writes exactly one audit row and updates the step', async () => {
        const created = await createLeaseWithPastAndFutureStep();
        const [pastStep] = await leaseRepo.listRentSteps(orgId, db, created.id);
        expect(pastStep?.effectiveFrom).toBe('2020-06-01');

        const corrected = await leaseRepo.correctRentStep(orgId, db, created.id, pastStep!.id, userId, {
          rentCents: 105000,
          reason: 'Good tenant, only a 5% increase instead of 10%.',
        });

        expect(corrected?.rentCents).toBe(105000);
        expect(corrected?.source).toBe('manual');

        const corrections = await leaseRepo.listRentStepCorrections(orgId, db, created.id);
        expect(corrections).toHaveLength(1);
        expect(corrections[0]).toMatchObject({
          stepId: pastStep!.id,
          oldRentCents: 110000,
          newRentCents: 105000,
          reason: 'Good tenant, only a 5% increase instead of 10%.',
          correctedByUserId: userId,
        });
      });

      it('correctRentStep on a FUTURE step 409s — "has not taken effect yet"', async () => {
        const created = await createLeaseWithPastAndFutureStep();
        const steps = await leaseRepo.listRentSteps(orgId, db, created.id);
        const futureStep = steps.find((s) => s.effectiveFrom === '2030-06-01')!;

        await expect(
          leaseRepo.correctRentStep(orgId, db, created.id, futureStep.id, userId, {
            rentCents: 130000,
            reason: 'Trying to correct a step that has not taken effect yet.',
          }),
        ).rejects.toMatchObject({ code: 'conflict' });
      });

      it('§4.6 THE dedicated test: a stepId from ANOTHER of this org\'s own leases 404s against this lease — resolved by (org_id, lease_id, id), never id alone', async () => {
        const leaseA = await createLeaseWithPastAndFutureStep();
        const leaseB = await createLeaseWithPastAndFutureStep();
        const [stepOnA] = await leaseRepo.listRentSteps(orgId, db, leaseA.id);

        // Same org, but stepOnA belongs to leaseA — calling it against leaseB must
        // read as "not found", never silently correct the wrong lease's step.
        const result = await leaseRepo.correctRentStep(orgId, db, leaseB.id, stepOnA!.id, userId, {
          rentCents: 130000,
          reason: 'Should never apply — foreign step id for this lease.',
        });
        expect(result).toBeNull();

        // leaseB's own step is untouched.
        const stillThere = await leaseRepo.listRentSteps(orgId, db, leaseB.id);
        expect(stillThere.find((s) => s.id === stepOnA!.id)).toBeUndefined();
      });

      it("cross-org: org B's correctRentStep for org A's (lease, step) returns null, never reaching the UPDATE", async () => {
        const created = await createLeaseWithPastAndFutureStep();
        const [pastStep] = await leaseRepo.listRentSteps(orgId, db, created.id);

        const result = await leaseRepo.correctRentStep(otherOrgId, db, created.id, pastStep!.id, userId, {
          rentCents: 999999,
          reason: 'Should never apply — wrong org entirely.',
        });
        expect(result).toBeNull();

        const stillOriginal = await leaseRepo.listRentSteps(orgId, db, created.id);
        expect(stillOriginal.find((s) => s.id === pastStep!.id)?.rentCents).toBe(110000);
      });

      it("cross-org: org B's replaceRentSteps for org A's lease id returns null", async () => {
        const created = await createLeaseWithPastAndFutureStep();
        const result = await leaseRepo.replaceRentSteps(otherOrgId, db, created.id, {
          steps: [{ effectiveFrom: '2030-06-01', rentCents: 1, source: 'manual' }],
        });
        expect(result).toBeNull();
      });
    });
  });
});
