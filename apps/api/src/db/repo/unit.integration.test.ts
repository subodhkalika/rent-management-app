import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@rms/contract';
import { createDb, type Database } from '../index.js';
import { organization, property, unit } from '../schema.js';
import * as propertyRepo from './property.js';
import * as unitRepo from './unit.js';

/**
 * REAL Postgres tests for the shape added by docs/BUGS.md #6 — `unit.type` and the
 * now-nullable `bedrooms`/`bathrooms` — against a running database that already has
 * real rows migrated by 0008_smiling_blue_marvel.sql. `unit.test.ts` only proves the
 * query SHAPE via `.toSQL()`; this half proves the round trip actually happens and
 * that org B still cannot reach org A's unit.
 *
 * SKIPPED ENTIRELY when `DATABASE_URL` is unset — see charge.integration.test.ts's
 * own comment for how to run this for real (`pnpm --filter api test:live`).
 */

const DATABASE_URL = process.env.DATABASE_URL;
const NEON_LOCAL_FETCH_ENDPOINT = process.env.NEON_LOCAL_FETCH_ENDPOINT;

describe.skipIf(!DATABASE_URL)('unit.ts — bedrooms/bathrooms nullable, unit.type — live Postgres', () => {
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let propertyId: string;

  beforeAll(() => {
    db = createDb(DATABASE_URL!, NEON_LOCAL_FETCH_ENDPOINT);
  });

  beforeEach(async () => {
    orgId = `itest_org_${uuidv7()}`;
    otherOrgId = `itest_org_other_${uuidv7()}`;

    await db.insert(organization).values({ id: orgId, name: 'Unit Test Org', slug: orgId });
    await db.insert(organization).values({ id: otherOrgId, name: 'Unit Test Org (other)', slug: otherOrgId });

    const propRow = await propertyRepo.createProperty(orgId, db, {
      name: 'Test Property',
      type: 'apartment',
      address: { line1: '1 Test St', city: 'Testville', region: 'TS', postalCode: '00000', country: 'US' },
      timezone: 'UTC',
      moveOutBillingPolicy: 'bill_full_term',
      calendar: 'gregorian',
    });
    propertyId = propRow.id;
  });

  afterEach(async () => {
    for (const org of [orgId, otherOrgId]) {
      await db.delete(unit).where(eq(unit.orgId, org));
      await db.delete(property).where(eq(property.orgId, org));
      await db.delete(organization).where(eq(organization.id, org));
    }
  });

  it('a shutter created with no room counts round-trips as null, not zero', async () => {
    const created = await unitRepo.createUnit(orgId, db, propertyId, {
      label: 'Shop 1',
      type: 'shutter',
      marketRentCents: 50_000,
      currency: 'NPR',
      status: 'vacant',
    });

    expect(created.type).toBe('shutter');
    expect(created.bedrooms).toBeNull();
    expect(created.bathrooms).toBeNull();

    const fetched = await unitRepo.getUnit(orgId, db, created.id);
    expect(fetched?.bedrooms).toBeNull();
    expect(fetched?.bathrooms).toBeNull();
    expect(fetched?.currency).toBe('NPR');
  });

  it('an existing flat keeps its bedroom and bathroom counts', async () => {
    const created = await unitRepo.createUnit(orgId, db, propertyId, {
      label: '1A',
      type: 'flat',
      bedrooms: 2,
      bathrooms: 1.5,
      marketRentCents: 150_000,
      currency: 'USD',
      status: 'vacant',
    });

    const fetched = await unitRepo.getUnit(orgId, db, created.id);
    expect(fetched?.type).toBe('flat');
    expect(fetched?.bedrooms).toBe(2);
    expect(fetched?.bathrooms).toBe(1.5);
  });

  it('org B cannot read, update or delete org A\'s unit', async () => {
    const created = await unitRepo.createUnit(orgId, db, propertyId, {
      label: '1A',
      type: 'flat',
      bedrooms: 1,
      bathrooms: 1,
      marketRentCents: 100_000,
      currency: 'USD',
      status: 'vacant',
    });

    const readAttempt = await unitRepo.getUnit(otherOrgId, db, created.id);
    expect(readAttempt).toBeNull();

    const updateAttempt = await unitRepo.updateUnit(otherOrgId, db, created.id, { label: 'Hijacked' });
    expect(updateAttempt).toBeNull();

    const deleteAttempt = await unitRepo.softDeleteUnit(otherOrgId, db, created.id);
    expect(deleteAttempt).toBe(false);

    // Row is untouched from org A's point of view.
    const stillThere = await unitRepo.getUnit(orgId, db, created.id);
    expect(stillThere?.label).toBe('1A');
    expect(stillThere?.deletedAt).toBeNull();
  });
});
