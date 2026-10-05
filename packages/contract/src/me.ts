import { z } from 'zod';
import { uuid } from './common.js';

/**
 * Who am I, and in what capacity?
 *
 * The web app cannot infer actor type from "has an organization": a tenant can create
 * their own organization (Better Auth allows it, and it reaches nothing), and one
 * person can genuinely be both a landlord and somebody else's tenant. So the server
 * answers directly and the client branches on this, never on a guess.
 *
 * Both lists can be non-empty at once. Neither being present means a signed-in user
 * who has not yet created an organization — send them to onboarding.
 */

export const landlordContext = z.object({
  orgId: z.string(),
  orgName: z.string(),
  role: z.string(),
});
export type LandlordContext = z.infer<typeof landlordContext>;

export const tenancyContext = z.object({
  orgId: z.string(),
  /** The landlord's organization name — what the tenant recognises. */
  orgName: z.string(),
  tenantId: uuid,
});
export type TenancyContext = z.infer<typeof tenancyContext>;

export const meContext = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
  }),
  /** Non-null when the user is a member of an organization. */
  landlord: landlordContext.nullable(),
  /** One entry per live tenant record pointing at this user, across all orgs. */
  tenancies: z.array(tenancyContext),
});
export type MeContext = z.infer<typeof meContext>;

/** Where the app should send this user on sign-in. */
export function primaryActor(ctx: MeContext): 'landlord' | 'tenant' | 'onboarding' {
  if (ctx.landlord) return 'landlord';
  if (ctx.tenancies.length > 0) return 'tenant';
  return 'onboarding';
}
