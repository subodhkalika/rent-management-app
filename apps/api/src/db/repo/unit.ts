import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { uuidv7, type CreateUnitBody, type UpdateUnitBody } from '@rms/contract';
import type { Database } from '../index.js';
import { property, unit } from '../schema.js';
import { conflict } from '../../lib/errors.js';
import { decodeCursor } from '../../lib/pagination.js';
import { isUniqueViolation } from '../../lib/db-errors.js';

export type UnitRow = typeof unit.$inferSelect;

/**
 * Non-correlated subquery: ids of this org's currently-live (non-soft-deleted)
 * properties. `softDeleteProperty` cascades `deletedAt` onto a property's units in
 * the same call (see property.ts), so this is belt-and-suspenders — it closes the
 * gap for anything that reaches a unit by id alone and would otherwise only need
 * the cascade to have run correctly.
 *
 * Not exported: the tenancy guard only needs to check functions that run a query
 * directly, and every caller below still has its own top-level `orgId` filter too.
 */
function liveProperties(orgId: string, db: Database) {
  return db
    .select({ id: property.id })
    .from(property)
    .where(and(eq(property.orgId, orgId), isNull(property.deletedAt)));
}

export function listUnitsQuery(
  orgId: string,
  db: Database,
  propertyId: string,
  opts: { limit: number; cursor?: string },
) {
  const conditions = [eq(unit.orgId, orgId), eq(unit.propertyId, propertyId), isNull(unit.deletedAt)];
  if (opts.cursor) conditions.push(gt(unit.id, decodeCursor(opts.cursor)));

  return db
    .select()
    .from(unit)
    .where(and(...conditions))
    .orderBy(asc(unit.id))
    .limit(opts.limit + 1);
}

export async function listUnits(
  orgId: string,
  db: Database,
  propertyId: string,
  opts: { limit: number; cursor?: string },
): Promise<{ rows: UnitRow[]; hasMore: boolean }> {
  const rows = await listUnitsQuery(orgId, db, propertyId, opts);
  const hasMore = rows.length > opts.limit;
  return { rows: hasMore ? rows.slice(0, opts.limit) : rows, hasMore };
}

export function getUnitQuery(orgId: string, db: Database, id: string) {
  return db
    .select()
    .from(unit)
    .where(
      and(
        eq(unit.orgId, orgId),
        eq(unit.id, id),
        isNull(unit.deletedAt),
        inArray(unit.propertyId, liveProperties(orgId, db)),
      ),
    )
    .limit(1);
}

export async function getUnit(orgId: string, db: Database, id: string): Promise<UnitRow | null> {
  const [row] = await getUnitQuery(orgId, db, id);
  return row ?? null;
}

/**
 * Insert query builder, split out from `createUnit` so a test can assert on its
 * `.toSQL()` the same way the read queries above are (unit.test.ts).
 *
 * The `unit_label_uq` index is `(orgId, propertyId, label)` with no `deletedAt`
 * clause (see schema.ts), so a label collision — including against a soft-deleted
 * unit — surfaces as a Postgres unique-violation (23505) rather than an app-level
 * pre-check. `createUnit` catches it and translates it to the contract's
 * `409 conflict` instead of letting it fall through as an unhandled 500.
 */
export function createUnitQuery(
  orgId: string,
  db: Database,
  propertyId: string,
  id: string,
  data: CreateUnitBody,
) {
  return db.insert(unit).values({
    id,
    orgId,
    propertyId,
    label: data.label,
    bedrooms: data.bedrooms,
    bathrooms: data.bathrooms,
    squareFeet: data.squareFeet ?? null,
    marketRentCents: data.marketRentCents,
    currency: data.currency,
    status: data.status,
    notes: data.notes ?? null,
  });
}

export async function createUnit(
  orgId: string,
  db: Database,
  propertyId: string,
  data: CreateUnitBody,
): Promise<UnitRow> {
  const id = uuidv7();
  try {
    await createUnitQuery(orgId, db, propertyId, id, data);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`A unit labeled "${data.label}" already exists in this property`);
    }
    throw err;
  }

  const created = await getUnit(orgId, db, id);
  if (!created) throw new Error('Unit not found immediately after insert');
  return created;
}

/**
 * Update query builder, split out from `updateUnit` so its `WHERE` can be asserted
 * via `.toSQL()` without a live database — see `property.ts`'s `updatePropertyQuery`
 * for why this matters: a dropped `eq(orgId, ...)` here would let any caller
 * holding a unit UUID mutate another org's row, and only reading the generated SQL
 * text catches that.
 */
export function updateUnitQuery(orgId: string, db: Database, id: string, data: UpdateUnitBody) {
  const patch: Partial<typeof unit.$inferInsert> = { updatedAt: new Date() };
  if (data.label !== undefined) patch.label = data.label;
  if (data.bedrooms !== undefined) patch.bedrooms = data.bedrooms;
  if (data.bathrooms !== undefined) patch.bathrooms = data.bathrooms;
  if (data.squareFeet !== undefined) patch.squareFeet = data.squareFeet ?? null;
  if (data.marketRentCents !== undefined) patch.marketRentCents = data.marketRentCents;
  if (data.currency !== undefined) patch.currency = data.currency;
  if (data.status !== undefined) patch.status = data.status;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;

  return db
    .update(unit)
    .set(patch)
    .where(
      and(
        eq(unit.orgId, orgId),
        eq(unit.id, id),
        isNull(unit.deletedAt),
        inArray(unit.propertyId, liveProperties(orgId, db)),
      ),
    )
    .returning({ id: unit.id });
}

export async function updateUnit(
  orgId: string,
  db: Database,
  id: string,
  data: UpdateUnitBody,
): Promise<UnitRow | null> {
  let result: { id: string }[];
  try {
    result = await updateUnitQuery(orgId, db, id, data);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`A unit labeled "${data.label ?? ''}" already exists in this property`);
    }
    throw err;
  }

  if (result.length === 0) return null;
  return getUnit(orgId, db, id);
}

/** Soft-delete query builder, split out so its `WHERE` is independently assertable
 *  via `.toSQL()` — see `updateUnitQuery` above for why. */
export function softDeleteUnitQuery(orgId: string, db: Database, id: string) {
  return db
    .update(unit)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(unit.orgId, orgId),
        eq(unit.id, id),
        isNull(unit.deletedAt),
        inArray(unit.propertyId, liveProperties(orgId, db)),
      ),
    )
    .returning({ id: unit.id });
}

/** Soft delete: leases and payments reference units, so financial history must
 *  survive a landlord removing a unit. Returns whether a row was actually
 *  (soft-)deleted, so the route can 404 instead of silently no-op-ing. */
export async function softDeleteUnit(orgId: string, db: Database, id: string): Promise<boolean> {
  const result = await softDeleteUnitQuery(orgId, db, id);
  return result.length > 0;
}

/** Bulk soft-delete query builder, split out for the same `.toSQL()`-assertion
 *  reason as the others above. */
export function softDeleteUnitsByPropertyQuery(orgId: string, db: Database, propertyId: string) {
  return db
    .update(unit)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(unit.orgId, orgId), eq(unit.propertyId, propertyId), isNull(unit.deletedAt)));
}

/**
 * Soft-deletes every live unit under `propertyId`, in one statement. Called by
 * `softDeleteProperty` (property.ts) so a deleted property can't leave units
 * readable at `GET /v1/units/:id` or mutable at `PATCH`/`DELETE` — those routes
 * only ever see a unit through `orgId` + `id`, never through the property's state,
 * so without this the unit rows would simply outlive their parent.
 */
export async function softDeleteUnitsByProperty(
  orgId: string,
  db: Database,
  propertyId: string,
): Promise<void> {
  await softDeleteUnitsByPropertyQuery(orgId, db, propertyId);
}
