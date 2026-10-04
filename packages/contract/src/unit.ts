import { z } from 'zod';
import { money, currency, uuid } from './common.js';

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
  bedrooms: z.number().int().min(0).max(50),
  bathrooms: z.number().min(0).max(50).multipleOf(0.5, 'Use halves, e.g. 1.5'),
  squareFeet: z.number().int().positive().max(1_000_000).optional(),
  /** Asking rent in integer cents. Actual rent is set by the lease. */
  marketRentCents: money,
  currency,
  status: unitStatus.default('vacant'),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateUnitBody = z.infer<typeof createUnitBody>;

export const updateUnitBody = createUnitBody.partial();
export type UpdateUnitBody = z.infer<typeof updateUnitBody>;

/* ---------- responses ---------- */

export const unit = z.object({
  id: uuid,
  propertyId: uuid,
  label: z.string(),
  bedrooms: z.number().int(),
  bathrooms: z.number(),
  squareFeet: z.number().int().nullable(),
  marketRentCents: z.number().int(),
  currency,
  status: unitStatus,
  notes: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Unit = z.infer<typeof unit>;
