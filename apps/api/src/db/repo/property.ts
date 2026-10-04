import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7, type CreatePropertyBody, type UpdatePropertyBody } from '@rms/contract';
import type { Database } from '../index.js';
import { property, unit } from '../schema.js';
import { decodeCursor } from '../../lib/pagination.js';

/**
 * A property row with its unit counts folded in. `unitCount` / `occupiedUnitCount`
 * are never stored — they're derived from the `unit` table on every read via a
 * single aggregate query (one join, not one query per property).
 */
export interface PropertyRow {
  id: string;
  name: string;
  type: (typeof property.$inferSelect)['type'];
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  notes: string | null;
  unitCount: number;
  occupiedUnitCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Shared column + aggregate selection, reused by both query builders below so the
 *  unit-count math is defined exactly once. */
const propertyColumns = {
  id: property.id,
  name: property.name,
  type: property.type,
  addressLine1: property.addressLine1,
  addressLine2: property.addressLine2,
  city: property.city,
  region: property.region,
  postalCode: property.postalCode,
  country: property.country,
  notes: property.notes,
  createdAt: property.createdAt,
  updatedAt: property.updatedAt,
  unitCount: sql<number>`count(${unit.id}) filter (where ${unit.deletedAt} is null)`.mapWith(Number),
  occupiedUnitCount: sql<number>`
    count(${unit.id}) filter (where ${unit.deletedAt} is null and ${unit.status} = 'occupied')
  `.mapWith(Number),
};

export function listPropertiesQuery(
  orgId: string,
  db: Database,
  opts: { limit: number; cursor?: string },
) {
  const conditions = [eq(property.orgId, orgId), isNull(property.deletedAt)];
  if (opts.cursor) conditions.push(gt(property.id, decodeCursor(opts.cursor)));

  return db
    .select(propertyColumns)
    .from(property)
    .leftJoin(unit, eq(unit.propertyId, property.id))
    .where(and(...conditions))
    .groupBy(property.id)
    .orderBy(asc(property.id))
    .limit(opts.limit + 1);
}

export async function listProperties(
  orgId: string,
  db: Database,
  opts: { limit: number; cursor?: string },
): Promise<{ rows: PropertyRow[]; hasMore: boolean }> {
  const rows = await listPropertiesQuery(orgId, db, opts);
  const hasMore = rows.length > opts.limit;
  return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
}

export function getPropertyQuery(orgId: string, db: Database, id: string) {
  return db
    .select(propertyColumns)
    .from(property)
    .leftJoin(unit, eq(unit.propertyId, property.id))
    .where(and(eq(property.orgId, orgId), eq(property.id, id), isNull(property.deletedAt)))
    .groupBy(property.id)
    .limit(1);
}

export async function getProperty(orgId: string, db: Database, id: string): Promise<PropertyRow | null> {
  const [row] = await getPropertyQuery(orgId, db, id);
  return row ?? null;
}

export async function createProperty(
  orgId: string,
  db: Database,
  data: CreatePropertyBody,
): Promise<PropertyRow> {
  const id = uuidv7();
  await db.insert(property).values({
    id,
    orgId,
    name: data.name,
    type: data.type,
    addressLine1: data.address.line1,
    addressLine2: data.address.line2 ?? null,
    city: data.address.city,
    region: data.address.region,
    postalCode: data.address.postalCode,
    country: data.address.country,
    notes: data.notes ?? null,
  });

  const created = await getProperty(orgId, db, id);
  if (!created) throw new Error('Property not found immediately after insert');
  return created;
}

export async function updateProperty(
  orgId: string,
  db: Database,
  id: string,
  data: UpdatePropertyBody,
): Promise<PropertyRow | null> {
  const patch: Partial<typeof property.$inferInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.type !== undefined) patch.type = data.type;
  if (data.address !== undefined) {
    patch.addressLine1 = data.address.line1;
    patch.addressLine2 = data.address.line2 ?? null;
    patch.city = data.address.city;
    patch.region = data.address.region;
    patch.postalCode = data.address.postalCode;
    patch.country = data.address.country;
  }
  if (data.notes !== undefined) patch.notes = data.notes ?? null;

  const result = await db
    .update(property)
    .set(patch)
    .where(and(eq(property.orgId, orgId), eq(property.id, id), isNull(property.deletedAt)))
    .returning({ id: property.id });

  if (result.length === 0) return null;
  return getProperty(orgId, db, id);
}

/** Soft delete: leases and payments reference properties, so financial history must
 *  survive a landlord removing one from their active list. Returns whether a row
 *  was actually (soft-)deleted, so the route can 404 instead of silently no-op-ing. */
export async function softDeleteProperty(orgId: string, db: Database, id: string): Promise<boolean> {
  const result = await db
    .update(property)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(property.orgId, orgId), eq(property.id, id), isNull(property.deletedAt)))
    .returning({ id: property.id });

  return result.length > 0;
}
