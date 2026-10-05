import { z } from 'zod';
import { uuid } from './common.js';

/**
 * A tenant is a PERSON the landlord manages, not a login. The two are linked
 * optionally: `portalAccess` says whether this person has been given one.
 *
 * A tenant user is deliberately NOT an organization member — see docs/PLAN-V1.md §1.
 * Membership is what `requireAuth` authorizes on, so a tenant holding a member row
 * would reach every landlord route ever written.
 */
export const tenantStatus = z.enum(['prospect', 'active', 'past', 'archived']);
export type TenantStatus = z.infer<typeof tenantStatus>;

export const tenantStatusLabels: Record<TenantStatus, string> = {
  prospect: 'Prospect',
  active: 'Active',
  past: 'Past',
  archived: 'Archived',
};

/** Whether this tenant can sign in to the portal, and how far along that is. */
export const portalAccess = z.enum(['none', 'invited', 'active', 'revoked']);
export type PortalAccess = z.infer<typeof portalAccess>;

export const portalAccessLabels: Record<PortalAccess, string> = {
  none: 'No portal access',
  invited: 'Invited',
  active: 'Active',
  revoked: 'Revoked',
};

/* ---------- requests ---------- */

export const createTenantBody = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  /** Optional, but required before the tenant can be invited to the portal. */
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  emergencyContactName: z.string().trim().max(200).optional(),
  emergencyContactPhone: z.string().trim().max(40).optional(),
  /** Landlord-private. Never returned by any portal endpoint. */
  notes: z.string().trim().max(2000).optional(),
  status: tenantStatus.default('prospect'),
});
export type CreateTenantBody = z.infer<typeof createTenantBody>;

export const updateTenantBody = createTenantBody.partial();
export type UpdateTenantBody = z.infer<typeof updateTenantBody>;

/* ---------- responses ---------- */

export const tenant = z.object({
  id: uuid,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  notes: z.string().nullable(),
  status: tenantStatus,
  portalAccess,
  /** Set once an invite is accepted. Lets the landlord see which login is bound. */
  portalEmail: z.string().nullable(),
  remindersOptedOut: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Tenant = z.infer<typeof tenant>;

export function tenantFullName(t: Pick<Tenant, 'firstName' | 'lastName'>): string {
  return `${t.firstName} ${t.lastName}`.trim();
}
