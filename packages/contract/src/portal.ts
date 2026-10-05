import { z } from 'zod';
import { uuid } from './common.js';

/**
 * Tenant-facing responses.
 *
 * These are deliberately NOT the landlord shapes with fields removed — they are
 * separate types, so adding a landlord-private column can never leak through a
 * shared schema. `tenant.notes` in particular is landlord-private and appears
 * nowhere below.
 */

export const portalProfile = z.object({
  tenantId: uuid,
  orgId: z.string(),
  /** The landlord's organization name. */
  landlordName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  remindersOptedOut: z.boolean(),
});
export type PortalProfile = z.infer<typeof portalProfile>;

/** The only fields a tenant may change about themselves. */
export const updatePortalProfileBody = z.object({
  phone: z.string().trim().max(40).optional(),
  emergencyContactName: z.string().trim().max(200).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  remindersOptedOut: z.boolean().optional(),
});
export type UpdatePortalProfileBody = z.infer<typeof updatePortalProfileBody>;
