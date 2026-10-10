import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  portalProfile,
  acceptInviteBody,
  inviteAccepted,
  invitePreview,
  portalLease,
  portalLeaseDetail,
  portalCharge,
  portalPayment,
  portalBalance,
  paged,
  type PortalProfile,
  type UpdatePortalProfileBody,
  type AcceptInviteBody,
  type InviteAccepted,
  type InvitePreview,
  type PortalLease,
  type PortalLeaseDetail,
  type PortalBalance,
  type IsoDate,
} from '@rms/contract';
import { ApiClientError, request } from '@/lib/api';

export const portalKeys = {
  profile: (tenantId: string) => ['portal', 'profile', tenantId] as const,
};

export function usePortalProfile(tenantId: string) {
  return useQuery<PortalProfile, ApiClientError>({
    queryKey: portalKeys.profile(tenantId),
    queryFn: ({ signal }) =>
      request(routes.portal.profile(tenantId), { schema: portalProfile, signal }),
    enabled: tenantId.length > 0,
  });
}

export function useUpdatePortalProfile(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdatePortalProfileBody) =>
      request(routes.portal.profile(tenantId), { method: 'PATCH', body, schema: portalProfile }),
    onSuccess: (updated: PortalProfile) => {
      queryClient.setQueryData(portalKeys.profile(tenantId), updated);
    },
  });
}

/**
 * What the accept page may show before the caller proves anything beyond holding
 * the token — see `invitePreview` in the contract. Public, like `acceptInvite`,
 * and fails with the same uniform 404; `AcceptInvitePage` renders that failure
 * identically to a malformed token, never a more specific message.
 */
export function usePortalInvitePreview(token: string, options?: { enabled?: boolean }) {
  return useQuery<InvitePreview, ApiClientError>({
    queryKey: ['portal', 'invite-preview', token],
    queryFn: ({ signal }) =>
      request(routes.portal.invitePreview(token), { schema: invitePreview, signal }),
    enabled: options?.enabled ?? true,
  });
}

/**
 * Accepting an invite is public (no auth guard) — see `AcceptInvitePage`.
 * `acceptInviteBody` is re-exported here only so this is the one place that
 * imports it alongside the route, same pattern as every other feature.
 */
export function useAcceptInvite() {
  return useMutation<InviteAccepted, ApiClientError, AcceptInviteBody>({
    mutationFn: (body) =>
      request(routes.portal.acceptInvite(), {
        method: 'POST',
        body: acceptInviteBody.parse(body),
        schema: inviteAccepted,
      }),
  });
}

/* ======================================================================== */
/* leases — tenant-facing                                                    */
/* ======================================================================== */

export const portalLeasesKeys = {
  all: ['portal', 'leases'] as const,
  list: () => [...portalLeasesKeys.all, 'list'] as const,
  detail: (id: string) => [...portalLeasesKeys.all, 'detail', id] as const,
};

const portalLeaseListSchema = z.object({ items: z.array(portalLease) });

/** Unpaginated by design (docs/PLAN-PHASE2.md §4.2) — a tenant has a handful of
 *  leases across every org they're a tenant in. */
export function usePortalLeases() {
  return useQuery<PortalLease[], ApiClientError>({
    queryKey: portalLeasesKeys.list(),
    queryFn: async ({ signal }) => {
      const result = await request(routes.portal.leases(), { schema: portalLeaseListSchema, signal });
      return result.items;
    },
  });
}

export function usePortalLease(id: string) {
  return useQuery<PortalLeaseDetail, ApiClientError>({
    queryKey: portalLeasesKeys.detail(id),
    queryFn: ({ signal }) => request(routes.portal.lease(id), { schema: portalLeaseDetail, signal }),
    enabled: id.length > 0,
  });
}

/* ---------- charges ---------- */

export interface PortalChargeFilters {
  from?: IsoDate;
  to?: IsoDate;
}

const portalChargeList = paged(portalCharge);
type PortalChargeList = z.infer<typeof portalChargeList>;

function portalLeaseChargesUrl(leaseId: string, filters: PortalChargeFilters, cursor?: string) {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  const base = routes.portal.leaseCharges(leaseId);
  return qs ? `${base}?${qs}` : base;
}

/**
 * The tenant's statement for one lease (docs/PLAN-PHASE3A.md §9.2). No totals are
 * ever computed from this list — a sum with no payments against it changes meaning
 * the instant 3b ships, and telling a tenant they owe an amount they have already
 * paid is worse than showing nothing.
 */
export function usePortalLeaseCharges(leaseId: string, filters: PortalChargeFilters = {}) {
  return useInfiniteQuery<PortalChargeList, ApiClientError>({
    queryKey: ['portal', 'leases', leaseId, 'charges', filters] as const,
    queryFn: ({ pageParam, signal }) =>
      request(portalLeaseChargesUrl(leaseId, filters, pageParam as string | undefined), {
        schema: portalChargeList,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: leaseId.length > 0,
  });
}

/* ---------- payments and balance ---------- */

export interface PortalPaymentFilters {
  from?: IsoDate;
  to?: IsoDate;
}

const portalPaymentList = paged(portalPayment);
type PortalPaymentList = z.infer<typeof portalPaymentList>;

function portalLeasePaymentsUrl(leaseId: string, filters: PortalPaymentFilters, cursor?: string) {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  const base = routes.portal.leasePayments(leaseId);
  return qs ? `${base}?${qs}` : base;
}

/** The tenant's own payment history for this lease — their statement's other
 *  half, alongside `usePortalLeaseCharges`. Co-tenants see each other's payments
 *  (V1 §1.4: joint liability for one obligation). */
export function usePortalLeasePayments(leaseId: string, filters: PortalPaymentFilters = {}) {
  return useInfiniteQuery<PortalPaymentList, ApiClientError>({
    queryKey: ['portal', 'leases', leaseId, 'payments', filters] as const,
    queryFn: ({ pageParam, signal }) =>
      request(portalLeasePaymentsUrl(leaseId, filters, pageParam as string | undefined), {
        schema: portalPaymentList,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: leaseId.length > 0,
  });
}

/**
 * The balance headline — "You owe $X" or "You are $X in credit", never a signed
 * number (docs/PLAN-PHASE3B.md §7.2). `overdueCents` is the word "arrears"
 * avoided; `creditCents` is reported only when this tenant is linked to the
 * chain's latest lease, zeroed otherwise — both decided server-side.
 */
export function usePortalLeaseBalance(leaseId: string) {
  return useQuery<PortalBalance, ApiClientError>({
    queryKey: ['portal', 'leases', leaseId, 'balance'] as const,
    queryFn: ({ signal }) => request(routes.portal.leaseBalance(leaseId), { schema: portalBalance, signal }),
    enabled: leaseId.length > 0,
  });
}
