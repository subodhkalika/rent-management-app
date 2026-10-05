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

/**
 * What the accept page may show BEFORE the caller proves anything beyond holding the
 * token. Safe to expose: the token is 256 bits, so possessing it already demonstrates
 * possession of the emailed link.
 *
 * It must fail exactly like `acceptInvite` — one identical 404 for bad, expired,
 * revoked, already-accepted and archived. A preview that distinguished those cases
 * would become the enumeration oracle the accept endpoint was built to avoid, undoing
 * that property through a read-only route.
 */
export const invitePreview = z.object({
  /** The landlord's organization name — what the recipient recognises. */
  orgName: z.string(),
  /** First name only. Enough to confirm whose invite this is, without exposing a
   *  full identity to whoever holds a forwarded link. */
  tenantFirstName: z.string(),
  /** The address the invite was issued to. The account is created with THIS value,
   *  never one typed by the caller, so showing it read-only is honest. */
  email: z.string(),
  /** True when an account already exists at that address, so the page can offer
   *  "sign in to accept" instead of a password form. */
  accountExists: z.boolean(),
  expiresAt: z.string().datetime(),
});
export type InvitePreview = z.infer<typeof invitePreview>;
