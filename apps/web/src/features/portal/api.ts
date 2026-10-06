import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  portalProfile,
  acceptInviteBody,
  inviteAccepted,
  invitePreview,
  portalLease,
  portalLeaseDetail,
  type PortalProfile,
  type UpdatePortalProfileBody,
  type AcceptInviteBody,
  type InviteAccepted,
  type InvitePreview,
  type PortalLease,
  type PortalLeaseDetail,
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
