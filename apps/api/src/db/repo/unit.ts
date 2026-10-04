import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { uuidv7, type CreateUnitBody, type UpdateUnitBody } from '@rms/contract';
import type { Database } from '../index.js';
import { unit } from '../schema.js';
import { conflict } from '../../lib/errors.js';
import { decodeCursor } from '../../lib/pagination.js';
import { isUniqueViolation } from '../../lib/db-errors.js';

export type UnitRow = typeof unit.$inferSelect;

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
    .where(and(eq(unit.orgId, orgId), eq(unit.id, id), isNull(unit.deletedAt)))
    .limit(1);
}

export async function getUnit(orgId: string, db: Database, id: string): Promise<UnitRow | null> {
  const [row] = await getUnitQuery(orgId, db, id);
  return row ?? null;
}

/**
 * The `unit_label_uq` index is `(orgId, propertyId, label)` with no `deletedAt`
 * clause (see schema.ts), so a label collision — including against a soft-deleted
 * unit — surfaces as a Postgres unique-violation (23505) rather than an app-level
 * pre-check. We catch it here and translate it to the contract's `409 conflict`
 * instead of letting it fall through as an unhandled 500.
 */
export async function createUnit(
  orgId: string,
  db: Database,
  propertyId: string,
  data: CreateUnitBody,
): Promise<UnitRow> {
  const id = uuidv7();
  try {
    await db.insert(unit).values({
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

export async function updateUnit(
  orgId: string,
  db: Database,
  id: string,
  data: UpdateUnitBody,
): Promise<UnitRow | null> {
  const patch: Partial<typeof unit.$inferInsert> = { updatedAt: new Date() };
  if (data.label !== undefined) patch.label = data.label;
  if (data.bedrooms !== undefined) patch.bedrooms = data.bedrooms;
  if (data.bathrooms !== undefined) patch.bathrooms = data.bathrooms;
  if (data.squareFeet !== undefined) patch.squareFeet = data.squareFeet ?? null;
  if (data.marketRentCents !== undefined) patch.marketRentCents = data.marketRentCents;
  if (data.currency !== undefined) patch.currency = data.currency;
  if (data.status !== undefined) patch.status = data.status;
  if (data.notes !== undefined) patch.notes = data.notes ?? null;

  let result: { id: string }[];
  try {
    result = await db
      .update(unit)
      .set(patch)
      .where(and(eq(unit.orgId, orgId), eq(unit.id, id), isNull(unit.deletedAt)))
      .returning({ id: unit.id });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`A unit labeled "${data.label ?? ''}" already exists in this property`);
    }
    throw err;
  }

  if (result.length === 0) return null;
  return getUnit(orgId, db, id);
}

/** Soft delete: leases and payments reference units, so financial history must
 *  survive a landlord removing a unit. Returns whether a row was actually
 *  (soft-)deleted, so the route can 404 instead of silently no-op-ing. */
export async function softDeleteUnit(orgId: string, db: Database, id: string): Promise<boolean> {
  const result = await db
    .update(unit)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(unit.orgId, orgId), eq(unit.id, id), isNull(unit.deletedAt)))
    .returning({ id: unit.id });

  return result.length > 0;
}
