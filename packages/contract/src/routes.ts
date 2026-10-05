/**
 * Route descriptors — the single list of what the API exposes.
 *
 * The API registers handlers against these paths; the web client builds URLs from
 * them. Neither side hand-writes a path string, so a rename breaks the build on both
 * ends at once instead of 404-ing at runtime.
 */
export const routes = {
  properties: {
    list: () => '/v1/properties',
    create: () => '/v1/properties',
    get: (id: string) => `/v1/properties/${id}`,
    update: (id: string) => `/v1/properties/${id}`,
    remove: (id: string) => `/v1/properties/${id}`,
  },
  me: {
    /** Who am I and in what capacity. Both actors may be present at once. */
    context: () => '/v1/me/context',
  },
  tenants: {
    list: () => '/v1/tenants',
    create: () => '/v1/tenants',
    get: (id: string) => `/v1/tenants/${id}`,
    update: (id: string) => `/v1/tenants/${id}`,
    remove: (id: string) => `/v1/tenants/${id}`,
    /** Issue a portal invite. Returns the raw link once and never again. */
    invite: (id: string) => `/v1/tenants/${id}/invite`,
    /** Unbind the login and revoke outstanding invites. The move-out kill switch. */
    revokePortalAccess: (id: string) => `/v1/tenants/${id}/portal-access`,
  },
  portal: {
    /** Public: the caller is not signed in yet when accepting a fresh invite. */
    acceptInvite: () => '/v1/portal/invites/accept',
    /** Public. Fails with the same uniform 404 as acceptInvite — see invite.ts. */
    invitePreview: (token: string) => `/v1/portal/invites/${token}`,
    profile: (tenantId: string) => `/v1/portal/${tenantId}/profile`,
    /**
     * Registered in a separate `routes/portal-leases.ts`, mounted BEFORE `portal`
     * in `index.ts`, so `/v1/portal/leases/:id` can never be matched by the
     * `/v1/portal/:tenantId/profile` route (§4.2's routing footgun).
     */
    leases: () => '/v1/portal/leases',
    lease: (id: string) => `/v1/portal/leases/${id}`,
    leaseSchedule: (id: string) => `/v1/portal/leases/${id}/schedule`,
  },
  units: {
    list: (propertyId: string) => `/v1/properties/${propertyId}/units`,
    create: (propertyId: string) => `/v1/properties/${propertyId}/units`,
    get: (id: string) => `/v1/units/${id}`,
    update: (id: string) => `/v1/units/${id}`,
    remove: (id: string) => `/v1/units/${id}`,
  },
  leases: {
    list: () => '/v1/leases',
    create: () => '/v1/leases',
    get: (id: string) => `/v1/leases/${id}`,
    update: (id: string) => `/v1/leases/${id}`,
    remove: (id: string) => `/v1/leases/${id}`,
    activate: (id: string) => `/v1/leases/${id}/activate`,
    cancel: (id: string) => `/v1/leases/${id}/cancel`,
    end: (id: string) => `/v1/leases/${id}/end`,
    renew: (id: string) => `/v1/leases/${id}/renew`,
    schedule: (id: string) => `/v1/leases/${id}/schedule`,
    addTenant: (id: string) => `/v1/leases/${id}/tenants`,
    removeTenant: (id: string, tenantId: string) => `/v1/leases/${id}/tenants/${tenantId}/remove`,
    setPrimaryTenant: (id: string, tenantId: string) => `/v1/leases/${id}/tenants/${tenantId}/primary`,
  },
} as const;
