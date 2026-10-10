import { z } from 'zod';
import { money, currency, uuid , optionalText } from './common.js';

/**
 * What kind of thing is being let.
 *
 * The schema used to require a bedroom and a bathroom count, which assumes a
 * residential flat. Somebody renting a shop shutter has neither, and was being asked
 * for both — one of them mandatory. The type now decides which questions are even
 * asked, and `bedrooms`/`bathrooms` are optional in consequence.
 */
export const unitType = z.enum([
  'flat',
  'room',
  'house',
  'shutter',
  'garage',
  'office',
  'other',
]);
export type UnitType = z.infer<typeof unitType>;

export const unitTypeLabels: Record<UnitType, string> = {
  flat: 'Flat / apartment',
  room: 'Room',
  house: 'House',
  shutter: 'Shutter / shop',
  garage: 'Garage / parking',
  office: 'Office',
  other: 'Other',
};

/**
 * Whether a bedroom count means anything for this kind of unit.
 *
 * Exported so the form and any summary line agree about it, rather than each
 * deciding separately and drifting.
 */
export function unitTypeHasBedrooms(t: UnitType): boolean {
  return t === 'flat' || t === 'house';
}

/** A single room or a garage has no private bathroom worth counting; a shop has none. */
export function unitTypeHasBathrooms(t: UnitType): boolean {
  return t === 'flat' || t === 'house';
}

export const unitStatus = z.enum(['vacant', 'occupied', 'unavailable']);
export type UnitStatus = z.infer<typeof unitStatus>;

export const unitStatusLabels: Record<UnitStatus, string> = {
  vacant: 'Vacant',
  occupied: 'Occupied',
  unavailable: 'Unavailable',
};

/* ---------- requests ---------- */

export const createUnitBody = z.object({
  /** Door number or name, unique within its property. */
  label: z.string().trim().min(1, 'Unit label is required').max(50),
  type: unitType.default('flat'),
  /** Optional: meaningless for a shutter, a garage or a single room. */
  bedrooms: z.number().int().min(0).max(50).optional(),
  bathrooms: z.number().min(0).max(50).multipleOf(0.5, 'Use halves, e.g. 1.5').optional(),
  squareFeet: z.number().int().positive().max(1_000_000).optional(),
  /** Asking rent in integer cents. Actual rent is set by the lease. */
  marketRentCents: money,
  currency,
  status: unitStatus.default('vacant'),
  notes: optionalText(z.string().trim().max(2000)),
});
export type CreateUnitBody = z.infer<typeof createUnitBody>;

export const updateUnitBody = createUnitBody.partial();
export type UpdateUnitBody = z.infer<typeof updateUnitBody>;

/* ---------- responses ---------- */

export const unit = z.object({
  id: uuid,
  propertyId: uuid,
  label: z.string(),
  type: unitType,
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().nullable(),
  squareFeet: z.number().int().nullable(),
  marketRentCents: z.number().int(),
  currency,
  status: unitStatus,
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Unit = z.infer<typeof unit>;
