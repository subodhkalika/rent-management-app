import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@rms/contract';
import { createDb, type Database } from '../../index.js';
import { organization, user, property, unit, lease } from '../../schema.js';
import { listLeasesForGeneration } from './charges.js';
import * as propertyRepo from '../property.js';
import * as unitRepo from '../unit.js';

/**
 * THE direct proof of PLAN-PHASE3A.md §3.3's under-billing fix: the driving scan
 * is `status IN ('active','ended','terminated')`, never `'active'` alone.
 *
 * PLAN-V1's original pseudocode scanned `active` only — a lease ended on 8
 * October, effective 31 December, has status `ended` IMMEDIATELY (there is no
 * "pending end" state), so an `active`-only scan would never bill November or
 * December. This test seeds one lease in every status and asserts the scan
 * returns exactly the three that can still owe money, excluding the two that
 * never will (`draft`: never billed anything; `cancelled`: never will be).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('listLeasesForGeneration — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let userId: string;
  let propertyId: string;
  let unitId: string;

  beforeAll(async () => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
    orgId = `itest_org_system_charges_${uuidv7()}`;
    userId = `itest_user_system_charges_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'System Charges Test Org', slug: orgId });
    await db.insert(user).values({ id: userId, name: 'Test User', email: `${userId}@example.test` });

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
      status: 'occupied',
    });
    unitId = unitRow.id;
  });

  afterAll(async () => {
    await db.delete(lease).where(eq(lease.orgId, orgId));
    await db.delete(unit).where(eq(unit.orgId, orgId));
    await db.delete(property).where(eq(property.orgId, orgId));
    await db.delete(organization).where(eq(organization.id, orgId));
    await db.delete(user).where(eq(user.id, userId));
  });

  it('includes active, ended AND terminated leases — excludes draft and cancelled', async () => {
    const statuses = ['draft', 'active', 'ended', 'terminated', 'cancelled'] as const;
    const idByStatus = new Map<string, string>();

    for (const status of statuses) {
      const id = uuidv7();
      idByStatus.set(status, id);
      await db.insert(lease).values({
        id,
        orgId,
        unitId,
        chainId: id,
        startDate: '2026-01-01',
        endDate: status === 'ended' || status === 'terminated' ? '2026-12-31' : null,
        rentCents: 100000,
        currency: 'USD',
        rentFrequency: 'monthly',
        billingDay: 1,
        ledgerStartDate: '2026-01-01',
        status,
        endReason: status === 'ended' ? 'mutual' : status === 'terminated' ? 'breach' : null,
        createdByUserId: userId,
      });
    }

    const scanned = await listLeasesForGeneration(db);
    const scannedIdsForThisOrg = new Set(scanned.filter((r) => r.orgId === orgId).map((r) => r.id));

    expect(scannedIdsForThisOrg.has(idByStatus.get('active')!)).toBe(true);
    expect(scannedIdsForThisOrg.has(idByStatus.get('ended')!)).toBe(true);
    expect(scannedIdsForThisOrg.has(idByStatus.get('terminated')!)).toBe(true);
    expect(scannedIdsForThisOrg.has(idByStatus.get('draft')!)).toBe(false);
    expect(scannedIdsForThisOrg.has(idByStatus.get('cancelled')!)).toBe(false);
  });

  it('hands back the live moveOutBillingPolicy/calendar from the PROPERTY, and the orgId the generator must write under', async () => {
    // A SEPARATE unit — `lease_unit_active_uq` permits only one active lease per
    // unit, and the previous test already left one active on `unitId`.
    const secondUnit = await unitRepo.createUnit(orgId, db, propertyId, {
      label: '1B',
      bedrooms: 1,
      bathrooms: 1,
      marketRentCents: 100000,
      currency: 'USD',
      status: 'occupied',
    });

    const id = uuidv7();
    await db.insert(lease).values({
      id,
      orgId,
      unitId: secondUnit.id,
      chainId: id,
      startDate: '2026-01-01',
      rentCents: 100000,
      currency: 'USD',
      rentFrequency: 'monthly',
      billingDay: 1,
      ledgerStartDate: '2026-01-01',
      status: 'active',
      createdByUserId: userId,
    });

    const scanned = await listLeasesForGeneration(db);
    const row = scanned.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.orgId).toBe(orgId);
    expect(row?.moveOutBillingPolicy).toBe('bill_full_term');
    expect(row?.calendar).toBe('gregorian');
    expect(row?.propertyTimezone).toBe('UTC');
  });
});
