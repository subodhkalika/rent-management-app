import { z } from 'zod';
import { uuid } from './common.js';

export const propertyType = z.enum([
  'single_family',
  'multi_family',
  'apartment',
  'condo',
  'townhouse',
  'commercial',
]);
export type PropertyType = z.infer<typeof propertyType>;

export const propertyTypeLabels: Record<PropertyType, string> = {
  single_family: 'Single-family home',
  multi_family: 'Multi-family',
  apartment: 'Apartment building',
  condo: 'Condo',
  townhouse: 'Townhouse',
  commercial: 'Commercial',
};

export const address = z.object({
  line1: z.string().trim().min(1, 'Street address is required').max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1, 'City is required').max(100),
  region: z.string().trim().min(1, 'State / region is required').max(100),
  postalCode: z.string().trim().min(1, 'Postal code is required').max(20),
  country: z.string().trim().length(2, 'Use a 2-letter country code').toUpperCase(),
});
export type Address = z.infer<typeof address>;

export function formatAddress(a: Address): string {
  return [a.line1, a.line2, a.city, `${a.region} ${a.postalCode}`.trim()]
    .filter(Boolean)
    .join(', ');
}

/* ---------- requests ---------- */

export const createPropertyBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  type: propertyType,
  address,
  notes: z.string().trim().max(2000).optional(),
});
export type CreatePropertyBody = z.infer<typeof createPropertyBody>;

export const updatePropertyBody = createPropertyBody.partial();
export type UpdatePropertyBody = z.infer<typeof updatePropertyBody>;

/* ---------- responses ---------- */

export const property = z.object({
  id: uuid,
  name: z.string(),
  type: propertyType,
  address,
  notes: z.string().nullable(),
  unitCount: z.number().int().nonnegative(),
  occupiedUnitCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Property = z.infer<typeof property>;
