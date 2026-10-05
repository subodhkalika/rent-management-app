import { z } from 'zod';
import { uuid, timezone } from './common.js';
import { moveOutBillingPolicy } from './billing.js';
import { calendarSystem } from './calendar/index.js';

/**
 * Re-exported from `billing.ts`, same pattern as `rentFrequency` in `lease.ts` — no
 * cycle, `billing.ts` still imports only `common.ts`.
 */
export { moveOutBillingPolicy, calendarSystem };
export type { MoveOutBillingPolicy } from './billing.js';

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
  /**
   * IANA timezone of the property itself, not of the landlord or the tenant.
   *
   * This is the only timezone-sensitive value in the system: it answers "what is
   * today, here", which decides when rent is due and when a charge becomes overdue.
   * A Perth property settled in UTC would flip to overdue eight hours early.
   */
  timezone,
  /**
   * Whether an early move-out stops the rent. Optional, unlike `timezone`: the
   * default (`bill_full_term`) is legally conservative and preserves the behaviour
   * every existing property already has, so asking before the first save would be
   * friction with no safety benefit. See Amendment A.
   */
  moveOutBillingPolicy: moveOutBillingPolicy.default('bill_full_term'),
  /**
   * Which calendar defines this property's billing periods.
   *
   * A monthly lease in Bikram Sambat bills Baisakh to Jestha, not January to
   * February — so this changes what a period IS, not merely how dates are shown.
   * Per-property for the same reason timezone and the move-out policy are: it
   * follows the building and its market, not the account or the tenant.
   *
   * Dates are stored as Gregorian ISO under either setting. The calendar decides
   * where periods begin and end, never the storage format.
   */
  calendar: calendarSystem.default('gregorian'),
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
  timezone: z.string(),
  moveOutBillingPolicy,
  calendar: calendarSystem,
  unitCount: z.number().int().nonnegative(),
  occupiedUnitCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Property = z.infer<typeof property>;
