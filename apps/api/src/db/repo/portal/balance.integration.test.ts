import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@rms/contract';
import { createDb, type Database } from '../../index.js';
import { organization, user, property, unit, tenant, lease, leaseTenant, charge, payment } from '../../schema.js';
import * as unitRepo from '../unit.js';
import * as propertyRepo from '../property.js';
import * as tenantRepo from '../tenant.js';
import * as balanceRepo from './balance.js';
import type { TenantScope } from '../../../types.js';

/**
 * REAL tests against REAL Postgres for `repo/portal/balance.ts` — PLAN-
 * PHASE3B.md §7.3's chain-wide-allocation-but-lease-scoped-reporting rule, and
 * the credit-zeroing rule, both need REAL rows to prove (a `.toSQL()` test
 * cannot see which lease a credit is attributed to).
 *
 * SKIPPED ENTIRELY when `DATABASE_URL` is unset — `pnpm --filter api test:live`
 * from the repo root runs this for real.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('repo/portal/balance.ts — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let userId: string;
  let propertyId: string;
  let unitId: string;

  beforeAll(() => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
  });

  beforeEach(async () => {
    orgId = `itest_org_${uuidv7()}`;
    userId = `itest_user_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'Portal Balance Test Org', slug: orgId });
    await db.insert(user).values({ id: userId, name: 'Portal Balance Test User', email: `${userId}@example.test` });

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
  });

  afterEach(async () => {
    await db.delete(payment).where(eq(payment.orgId, orgId));
    await db.delete(charge).where(eq(charge.orgId, orgId));
    await db.delete(leaseTenant).where(eq(leaseTenant.orgId, orgId));
    await db.delete(lease).where(eq(lease.orgId, orgId));
    await db.delete(unit).where(eq(unit.orgId, orgId));
    await db.delete(property).where(eq(property.orgId, orgId));
    await db.delete(tenant).where(eq(tenant.orgId, orgId));
    await db.delete(organization).where(eq(organization.id, orgId));
    await db.delete(user).where(eq(user.id, userId));
  });

  async function insertLease(overrides: Partial<typeof lease.$inferInsert> = {}) {
    const id = uuidv7();
    const startDate = (overrides.startDate as string | undefined) ?? '2020-01-01';
    const row: typeof lease.$inferInsert = {
      id,
      orgId,
      unitId,
      chainId: id,
      startDate,
      endDate: null,
      rentCents: 100000,
      currency: 'USD',
      rentFrequency: 'monthly',
      billingDay: 1,
      depositCents: 0,
      openingBalanceCents: 0,
      // lease_ledger_ck requires ledger_start_date >= start_date — default it
      // to whatever startDate ends up being, not a fixed literal.
      ledgerStartDate: startDate,
      status: 'active',
      createdByUserId: userId,
      ...overrides,
    };
    await db.insert(lease).values(row);
    return row;
  }

  it("a departed roommate's own lease settles when the remaining tenant pays — never a debt the landlord considers cleared", async () => {
    const tenantA = await tenantRepo.createTenant(orgId, db, { firstName: 'Ana', lastName: 'Departed', status: 'past' });
    const tenantB = await tenantRepo.createTenant(orgId, db, { firstName: 'Ben', lastName: 'Remaining', status: 'active' });

    const leaseRow = await insertLease();
    await db.insert(leaseTenant).values([
      { id: uuidv7(), orgId, leaseId: leaseRow.id, tenantId: tenantA.id, isPrimary: false, addedOn: '2020-01-01', removedOn: '2020-01-15' },
      { id: uuidv7(), orgId, leaseId: leaseRow.id, tenantId: tenantB.id, isPrimary: true, addedOn: '2020-01-01' },
    ]);
    await db.insert(charge).values({
      id: uuidv7(),
      orgId,
      leaseId: leaseRow.id,
      type: 'rent',
      dueDate: '2020-02-01',
      amountCents: 100000,
      currency: 'USD',
      source: 'manual',
      createdByUserId: userId,
    });
    // Ben (the remaining tenant) pays in full, after Ana left.
    await db.insert(payment).values({
      id: uuidv7(),
      orgId,
      leaseId: leaseRow.id,
      kind: 'payment',
      method: 'bank_transfer',
      amountCents: 100000,
      currency: 'USD',
      receivedOn: '2020-02-05',
      recordedByUserId: userId,
    });

    // Ana still reads the lease — removed tenants read forever (§5.6) — and her
    // OWN balance reflects the SAME allocation, settled by Ben's payment.
    const scope: TenantScope = { userId: 'user_ana', pairs: [{ orgId, tenantId: tenantA.id }] };
    const result = await balanceRepo.portalBalanceForLease(scope, db, leaseRow.id, '2020-03-01');
    expect(result).not.toBeNull();
    expect(result!.outstandingCents).toBe(0);
    expect(result!.overdueCents).toBe(0);
  });

  it("a credit on a LATER lease in the chain is reported to the tenant on THAT lease, and zeroed for one only on an earlier lease", async () => {
    const tenantA = await tenantRepo.createTenant(orgId, db, { firstName: 'Ana', lastName: 'Former', status: 'past' });
    const tenantB = await tenantRepo.createTenant(orgId, db, { firstName: 'Ben', lastName: 'Current', status: 'active' });

    const oldLease = await insertLease({ startDate: '2019-01-01', endDate: '2019-12-31', status: 'ended' });
    const newLease = await insertLease({
      startDate: '2020-01-01',
      chainId: oldLease.chainId,
      renewedFromLeaseId: oldLease.id,
    });
    await db.insert(leaseTenant).values([
      { id: uuidv7(), orgId, leaseId: oldLease.id, tenantId: tenantA.id, isPrimary: true, addedOn: '2019-01-01', removedOn: '2019-12-31' },
      { id: uuidv7(), orgId, leaseId: newLease.id, tenantId: tenantB.id, isPrimary: true, addedOn: '2020-01-01' },
    ]);

    // The new lease's rent is overpaid, leaving a $500 credit on the CHAIN.
    await db.insert(charge).values({
      id: uuidv7(),
      orgId,
      leaseId: newLease.id,
      type: 'rent',
      dueDate: '2020-01-01',
      amountCents: 100000,
      currency: 'USD',
      source: 'manual',
      createdByUserId: userId,
    });
    await db.insert(payment).values({
      id: uuidv7(),
      orgId,
      leaseId: newLease.id,
      kind: 'payment',
      method: 'bank_transfer',
      amountCents: 150000,
      currency: 'USD',
      receivedOn: '2020-01-05',
      recordedByUserId: userId,
    });

    // Ben (on the CURRENT, latest lease) sees the $500 credit.
    const benScope: TenantScope = { userId: 'user_ben', pairs: [{ orgId, tenantId: tenantB.id }] };
    const benBalance = await balanceRepo.portalBalanceForLease(benScope, db, newLease.id, '2020-02-01');
    expect(benBalance!.creditCents).toBe(50000);

    // Ana (on the OLD, departed lease — not linked to the chain's latest lease)
    // never sees it, even though it is the SAME chain's money (§7.3's
    // information-leak rule).
    const anaScope: TenantScope = { userId: 'user_ana', pairs: [{ orgId, tenantId: tenantA.id }] };
    const anaBalance = await balanceRepo.portalBalanceForLease(anaScope, db, oldLease.id, '2020-02-01');
    expect(anaBalance!.creditCents).toBe(0);
  });

  it("co-tenants see each other's payments reflected in the shared balance — joint liability", async () => {
    const tenantA = await tenantRepo.createTenant(orgId, db, { firstName: 'Ana', lastName: 'One', status: 'active' });
    const tenantB = await tenantRepo.createTenant(orgId, db, { firstName: 'Ben', lastName: 'Two', status: 'active' });

    const leaseRow = await insertLease();
    await db.insert(leaseTenant).values([
      { id: uuidv7(), orgId, leaseId: leaseRow.id, tenantId: tenantA.id, isPrimary: true, addedOn: '2020-01-01' },
      { id: uuidv7(), orgId, leaseId: leaseRow.id, tenantId: tenantB.id, isPrimary: false, addedOn: '2020-01-01' },
    ]);
    await db.insert(charge).values({
      id: uuidv7(),
      orgId,
      leaseId: leaseRow.id,
      type: 'rent',
      dueDate: '2020-02-01',
      amountCents: 100000,
      currency: 'USD',
      source: 'manual',
      createdByUserId: userId,
    });
    // Ben pays; Ana's own balance reflects it too — one shared obligation.
    await db.insert(payment).values({
      id: uuidv7(),
      orgId,
      leaseId: leaseRow.id,
      kind: 'payment',
      method: 'bank_transfer',
      amountCents: 100000,
      currency: 'USD',
      receivedOn: '2020-02-01',
      recordedByUserId: userId,
    });

    const anaScope: TenantScope = { userId: 'user_ana', pairs: [{ orgId, tenantId: tenantA.id }] };
    const anaBalance = await balanceRepo.portalBalanceForLease(anaScope, db, leaseRow.id, '2020-03-01');
    expect(anaBalance!.outstandingCents).toBe(0);
  });

  it("the next-door-neighbour case: a tenant holding another tenant's lease id (same org) resolves to null", async () => {
    const tenantA = await tenantRepo.createTenant(orgId, db, { firstName: 'Ana', lastName: 'One', status: 'active' });
    const tenantC = await tenantRepo.createTenant(orgId, db, { firstName: 'Cara', lastName: 'Neighbour', status: 'active' });

    const leaseRow = await insertLease();
    await db.insert(leaseTenant).values({
      id: uuidv7(),
      orgId,
      leaseId: leaseRow.id,
      tenantId: tenantA.id,
      isPrimary: true,
      addedOn: '2020-01-01',
    });

    // Cara is a tenant in the SAME org, but not on this lease at all.
    const caraScope: TenantScope = { userId: 'user_cara', pairs: [{ orgId, tenantId: tenantC.id }] };
    const result = await balanceRepo.portalBalanceForLease(caraScope, db, leaseRow.id, '2020-03-01');
    expect(result).toBeNull();
  });
});
