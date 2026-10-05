import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { uuidv7, type CreatePropertyBody, type UpdatePropertyBody } from '@rms/contract';
import type { Database } from '../index.js';
import { property, unit } from '../schema.js';
import { decodeCursor } from '../../lib/pagination.js';
import { softDeleteUnitsByProperty } from './unit.js';

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
  timezone: string;
  moveOutBillingPolicy: (typeof property.$inferSelect)['moveOutBillingPolicy'];
  calendar: (typeof property.$inferSelect)['calendar'];
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
  timezone: property.timezone,
  moveOutBillingPolicy: property.moveOutBillingPolicy,
  calendar: property.calendar,
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
    // Scoped by orgId too, not just propertyId: nothing in the schema stops a unit
    // row from carrying an orgId that disagrees with its own property's (see
    // db/repo/unit.ts — same note on listUnitsQuery). No current path can create
    // that state, but an unscoped join would silently fold a mismatched unit's
    // counts into this org's property the moment one did.
    .leftJoin(unit, and(eq(unit.propertyId, property.id), eq(unit.orgId, orgId)))
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
    .leftJoin(unit, and(eq(unit.propertyId, property.id), eq(unit.orgId, orgId)))
    .where(and(eq(property.orgId, orgId), eq(property.id, id), isNull(property.deletedAt)))
    .groupBy(property.id)
    .limit(1);
}

export async function getProperty(orgId: string, db: Database, id: string): Promise<PropertyRow | null> {
  const [row] = await getPropertyQuery(orgId, db, id);
  return row ?? null;
}

/**
 * Insert query builder, split out from `createProperty` so a test can assert on its
 * `.toSQL()` (here, that `orgId` is one of the inserted values) the same way the
 * read queries above are asserted — see property.test.ts.
 */
export function createPropertyQuery(
  orgId: string,
  db: Database,
  id: string,
  data: CreatePropertyBody,
) {
  return db.insert(property).values({
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
    timezone: data.timezone,
    moveOutBillingPolicy: data.moveOutBillingPolicy,
    calendar: data.calendar,
    notes: data.notes ?? null,
  });
}

export async function createProperty(
  orgId: string,
  db: Database,
  data: CreatePropertyBody,
): Promise<PropertyRow> {
  const id = uuidv7();
  await createPropertyQuery(orgId, db, id, data);

  const created = await getProperty(orgId, db, id);
  if (!created) throw new Error('Property not found immediately after insert');
  return created;
}

/**
 * Update query builder, split out from `updateProperty` so its `WHERE` can be
 * asserted via `.toSQL()` without a live database (property.test.ts) — the same
 * motivation as `listPropertiesQuery`/`getPropertyQuery`: a dropped `eq(orgId, ...)`
 * here would let any caller holding a UUID mutate another org's property, and
 * nothing short of reading the SQL text catches that.
 */
export function updatePropertyQuery(
  orgId: string,
  db: Database,
  id: string,
  data: UpdatePropertyBody,
) {
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
  if (data.timezone !== undefined) patch.timezone = data.timezone;
  if (data.moveOutBillingPolicy !== undefined) patch.moveOutBillingPolicy = data.moveOutBillingPolicy;
  if (data.calendar !== undefined) patch.calendar = data.calendar;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;

  return db
    .update(property)
    .set(patch)
    .where(and(eq(property.orgId, orgId), eq(property.id, id), isNull(property.deletedAt)))
    .returning({ id: property.id });
}

export async function updateProperty(
  orgId: string,
  db: Database,
  id: string,
  data: UpdatePropertyBody,
): Promise<PropertyRow | null> {
  const result = await updatePropertyQuery(orgId, db, id, data);
  if (result.length === 0) return null;
  return getProperty(orgId, db, id);
}

/** Soft-delete query builder, split out so its `WHERE` is independently assertable
 *  via `.toSQL()` — see `updatePropertyQuery` above for why. */
export function softDeletePropertyQuery(orgId: string, db: Database, id: string) {
  return db
    .update(property)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(property.orgId, orgId), eq(property.id, id), isNull(property.deletedAt)))
    .returning({ id: property.id });
}

/**
 * Soft delete: leases and payments reference properties, so financial history must
 * survive a landlord removing one from their active list. Returns whether a row
 * was actually (soft-)deleted, so the route can 404 instead of silently no-op-ing.
 *
 * Cascades to the property's units in the same call. The FK's `onDelete: 'cascade'`
 * (schema.ts) only fires on a hard `DELETE`, never on this `UPDATE` — without doing
 * it here explicitly, a deleted property's units would keep `deletedAt IS NULL` and
 * stay fully readable and mutable at `/v1/units/:id`, while disappearing from the
 * property's own unit list. (This runs as two sequential statements, not a single
 * transaction: the Neon HTTP driver used here has no interactive transactions — see
 * db/index.ts.)
 */
export async function softDeleteProperty(orgId: string, db: Database, id: string): Promise<boolean> {
  const result = await softDeletePropertyQuery(orgId, db, id);
  if (result.length === 0) return false;

  await softDeleteUnitsByProperty(orgId, db, id);
  return true;
}
