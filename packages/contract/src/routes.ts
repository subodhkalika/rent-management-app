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
  charges: {
    /** Portfolio-wide, across every property. */
    list: () => '/v1/charges',
  },
  arrears: {
    list: () => '/v1/arrears',
  },
  internal: {
    /** Public: a watcher with no credentials must be able to see the cron is alive. */
    cronHealth: () => '/v1/internal/cron/health',
  },
  portal: {
    leasePayments: (leaseId: string) => `/v1/portal/leases/${leaseId}/payments`,
    leaseBalance: (leaseId: string) => `/v1/portal/leases/${leaseId}/balance`,

    leaseCharges: (leaseId: string) => `/v1/portal/leases/${leaseId}/charges`,

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
    payments: (leaseId: string) => `/v1/leases/${leaseId}/payments`,
    voidPayment: (leaseId: string, paymentId: string) => `/v1/leases/${leaseId}/payments/${paymentId}/void`,
    correctPayment: (leaseId: string, paymentId: string) => `/v1/leases/${leaseId}/payments/${paymentId}/correct`,
    updatePaymentNote: (leaseId: string, paymentId: string) => `/v1/leases/${leaseId}/payments/${paymentId}`,
    /** The whole tenancy, interleaved — charges and payments with a running balance. */
    ledger: (leaseId: string) => `/v1/leases/${leaseId}/ledger`,
    balance: (leaseId: string) => `/v1/leases/${leaseId}/balance`,

    charges: (leaseId: string) => `/v1/leases/${leaseId}/charges`,
    generateCharges: (leaseId: string) => `/v1/leases/${leaseId}/charges/generate`,
    /** Bill one period early, on purpose — a tenant paying next month's rent now. */
    generateNextPeriod: (leaseId: string) => `/v1/leases/${leaseId}/charges/generate-next-period`,
    /** Nested under the lease so the resolve is (org, lease, charge) — a bare charge
     *  id would leave it ambiguous whether it had been scoped. */
    voidCharge: (leaseId: string, chargeId: string) => `/v1/leases/${leaseId}/charges/${chargeId}/void`,
    correctCharge: (leaseId: string, chargeId: string) => `/v1/leases/${leaseId}/charges/${chargeId}/correct`,

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
    /** GET reads the ladder; PUT replaces the whole thing. See the escalation
     *  plan §4.1 — one endpoint, one rule, no patch-plus-cascade pair. */
    rentSteps: (id: string) => `/v1/leases/${id}/rent-steps`,
    correctRentStep: (id: string, stepId: string) => `/v1/leases/${id}/rent-steps/${stepId}/correct`,
    rentStepCorrections: (id: string) => `/v1/leases/${id}/rent-step-corrections`,
  },
} as const;
