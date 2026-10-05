import { z } from 'zod';

/**
 * Portal invites. Landlord-issued, single-use, emailed to the address on the tenant
 * record. The server stores only sha256(token) and looks invites up by that hash and
 * nothing else — never by email, never by tenant id — so no endpoint can be used to
 * discover whether an invite or a tenant exists. See docs/PLAN-V1.md §1.
 */

/** 32 random bytes, hex. Shown to the landlord exactly once, then unrecoverable. */
export const inviteToken = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'That invitation link is not valid');

/* ---------- requests ---------- */

/**
 * Accepting an invite has two shapes, distinguished by whether the caller is already
 * signed in:
 *
 * - signed out -> `account` is required; a new user is created using the email
 *   recorded ON THE INVITE, never one supplied by the caller
 * - signed in  -> `account` must be absent; the current user is bound. This is how
 *   one person attaches a second landlord to their existing login.
 */
export const acceptInviteBody = z.object({
  token: inviteToken,
  account: z
    .object({
      name: z.string().trim().min(1, 'Name is required').max(200),
      password: z.string().min(8, 'Use at least 8 characters').max(200),
    })
    .optional(),
});
export type AcceptInviteBody = z.infer<typeof acceptInviteBody>;

/* ---------- responses ---------- */

/**
 * Returned ONCE, on creation. `url` is the only time the raw token leaves the server,
 * so the landlord can copy it if the email bounces.
 */
export const inviteCreated = z.object({
  url: z.string().url(),
  email: z.string(),
  expiresAt: z.string().datetime(),
});
export type InviteCreated = z.infer<typeof inviteCreated>;

export const inviteAccepted = z.object({
  tenantId: z.string().uuid(),
  organizationName: z.string(),
  /** True when a new account was created, false when an existing login was bound. */
  accountCreated: z.boolean(),
});
export type InviteAccepted = z.infer<typeof inviteAccepted>;
