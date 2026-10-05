import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routes,
  portalProfile,
  acceptInviteBody,
  inviteAccepted,
  type PortalProfile,
  type UpdatePortalProfileBody,
  type AcceptInviteBody,
  type InviteAccepted,
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
