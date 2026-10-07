import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@rms/contract';
import { createDb, type Database } from '../../index.js';
import { organization, user, property, unit, tenant, lease, leaseTenant } from '../../schema.js';
import * as leaseRepo from '../lease.js';
import * as unitRepo from '../unit.js';
import * as propertyRepo from '../property.js';
import * as tenantRepo from '../tenant.js';
import * as portalLeaseRepo from './lease.js';
import type { TenantScope } from '../../../types.js';

/**
 * REAL tests against a real Postgres for HIGH 7 (PLAN-PHASE2.md review,
 * 2026-10-05): `listLeasesQuery`/`resolveLeaseQuery` joined `lease_tenant` with no
 * `removed_on` filter (correct — §5.6) and no dedup, so a tenant who left and came
 * back got the SAME lease twice, and `resolveLeaseQuery`'s bare `.limit(1)` with
 * no `ORDER BY` made which copy won (and therefore `yourRole`) nondeterministic.
 * A `.toSQL()` test cannot see a duplicate ROW — only a real query against real
 * duplicate data can. Also the §7 next-door-neighbour case, re-proven here against
 * real rows rather than a mocked `resolveLease`.
 *
 * Skipped without `DATABASE_URL` — see lease.integration.test.ts's module comment
 * for how to run this file for real; verified passing that way before reporting
 * done.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('portal/lease.ts — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let userId: string;
  let propertyId: string;
  let unitId: string;
  let danaTenantId: string; // Dana — the caller
  let ninaTenantId: string; // Nina — Dana's next-door neighbour, same org

  beforeAll(() => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
  });

  beforeEach(async () => {
    orgId = `itest_org_${uuidv7()}`;
    userId = `itest_user_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'Integration Test Org', slug: orgId });
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

    const dana = await tenantRepo.createTenant(orgId, db, { firstName: 'Dana', lastName: 'Lee', status: 'active' });
    danaTenantId = dana.id;
    const nina = await tenantRepo.createTenant(orgId, db, {
      firstName: 'Nina',
      lastName: 'Neighbour',
      status: 'active',
    });
    ninaTenantId = nina.id;
  });

  afterEach(async () => {
    await db.delete(leaseTenant).where(eq(leaseTenant.orgId, orgId));
    await db.delete(lease).where(eq(lease.orgId, orgId));
    await db.delete(unit).where(eq(unit.orgId, orgId));
    await db.delete(property).where(eq(property.orgId, orgId));
    await db.delete(tenant).where(eq(tenant.orgId, orgId));
    await db.delete(organization).where(eq(organization.id, orgId));
    await db.delete(user).where(eq(user.id, userId));
  });

  async function createDraftLeaseFor(tenantId: string, startDate: string) {
    const created = await leaseRepo.createLease(orgId, db, userId, {
      unitId,
      tenantIds: [tenantId],
      primaryTenantId: tenantId,
      startDate,
      endDate: null,
      rentCents: 100000,
      rentFrequency: 'monthly',
      billingDay: 1,
      depositCents: 0,
      ledgerStartDate: undefined,
      openingBalanceCents: 0,
      notes: undefined,
      escalation: null,
    });
    // Unit can only have one ACTIVE lease at a time — leave most leases as
    // draft (resolveLease/listLeases do not filter by status, see §6.3).
    return created;
  }

  /* ======================================================================== *
   * §7 — the next-door-neighbour case, against real rows
   * ======================================================================== */

  describe('the next-door-neighbour case', () => {
    it("Dana's scope resolves her own lease but not Nina's — same org, different tenant", async () => {
      const danaLease = await createDraftLeaseFor(danaTenantId, '2026-01-01');
      const ninaLease = await createDraftLeaseFor(ninaTenantId, '2027-01-01');

      const danaScope: TenantScope = { userId: 'user_dana', pairs: [{ orgId, tenantId: danaTenantId }] };

      const ownResolved = await portalLeaseRepo.resolveLease(danaScope, db, danaLease.id);
      expect(ownResolved).not.toBeNull();
      expect(ownResolved?.id).toBe(danaLease.id);

      const neighbourResolved = await portalLeaseRepo.resolveLease(danaScope, db, ninaLease.id);
      expect(neighbourResolved).toBeNull();

      const list = await portalLeaseRepo.listLeases(danaScope, db);
      expect(list.map((l) => l.id)).toEqual([danaLease.id]);
      expect(list.map((l) => l.id)).not.toContain(ninaLease.id);
    });

    it("Nina's coTenants never includes Dana — they share an org, not a lease", async () => {
      const ninaLease = await createDraftLeaseFor(ninaTenantId, '2026-01-01');
      const ninaScope: TenantScope = { userId: 'user_nina', pairs: [{ orgId, tenantId: ninaTenantId }] };

      const resolved = await portalLeaseRepo.resolveLease(ninaScope, db, ninaLease.id);
      expect(resolved?.coTenants).toEqual([]);
    });
  });

  /* ======================================================================== *
   * HIGH 7 — left and came back: dedup + deterministic ordering
   * ======================================================================== */

  describe('a tenant who left and came back', () => {
    // Dana stays primary throughout (removing a PRIMARY tenant requires
    // reassignment first, regardless of status — a separate rule, not what this
    // test is about). Nina joins as a roommate, leaves, and comes back — she is
    // the one whose lease_tenant history this test exercises.
    async function createLeaseWithRoommates() {
      const created = await createDraftLeaseFor(danaTenantId, '2026-01-01');
      await leaseRepo.addLeaseTenant(orgId, db, created.id, {
        tenantId: ninaTenantId,
        isPrimary: false,
        addedOn: '2026-01-01',
      });
      return created;
    }

    it('listLeases returns the lease exactly ONCE for the roommate, as current — never duplicated, never shown as former', async () => {
      const created = await createLeaseWithRoommates();

      // Leave, then come back — lease_tenant_live_uq is partial on
      // removed_on IS NULL specifically so this is legal (§3.4).
      await leaseRepo.removeLeaseTenant(orgId, db, created.id, ninaTenantId, { removedOn: '2026-03-01' });
      await leaseRepo.addLeaseTenant(orgId, db, created.id, {
        tenantId: ninaTenantId,
        isPrimary: false,
        addedOn: '2026-04-01',
      });

      // Two lease_tenant rows now exist for (this lease, Nina) — one historical,
      // one live. Confirm that premise directly before asserting the dedup fix.
      const rawRows = await db
        .select()
        .from(leaseTenant)
        .where(eq(leaseTenant.leaseId, created.id));
      expect(rawRows.filter((r) => r.tenantId === ninaTenantId)).toHaveLength(2);

      const ninaScope: TenantScope = { userId: 'user_nina', pairs: [{ orgId, tenantId: ninaTenantId }] };

      const list = await portalLeaseRepo.listLeases(ninaScope, db);
      const matches = list.filter((l) => l.id === created.id);
      expect(matches).toHaveLength(1); // not 2 — the dedup fix
      expect(matches[0]!.removedOn).toBeNull(); // the LIVE row won, not the historical one

      const resolved = await portalLeaseRepo.resolveLease(ninaScope, db, created.id);
      expect(resolved?.removedOn).toBeNull();

      // Dana (never removed) is unaffected by any of this.
      const danaScope: TenantScope = { userId: 'user_dana', pairs: [{ orgId, tenantId: danaTenantId }] };
      const danaList = await portalLeaseRepo.listLeases(danaScope, db);
      expect(danaList.filter((l) => l.id === created.id)).toHaveLength(1);
      expect(danaList.find((l) => l.id === created.id)?.removedOn).toBeNull();
    });

    it('a roommate who left and has NOT come back is still visible, correctly marked former (§5.6)', async () => {
      const created = await createLeaseWithRoommates();
      await leaseRepo.removeLeaseTenant(orgId, db, created.id, ninaTenantId, { removedOn: '2026-03-01' });

      const ninaScope: TenantScope = { userId: 'user_nina', pairs: [{ orgId, tenantId: ninaTenantId }] };

      const resolved = await portalLeaseRepo.resolveLease(ninaScope, db, created.id);
      expect(resolved).not.toBeNull();
      expect(resolved?.removedOn).toBe('2026-03-01');

      const list = await portalLeaseRepo.listLeases(ninaScope, db);
      expect(list.filter((l) => l.id === created.id)).toHaveLength(1);
      expect(list.find((l) => l.id === created.id)?.removedOn).toBe('2026-03-01');
    });
  });
});
