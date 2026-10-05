import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  routes,
  portalProfile,
  acceptInviteBody,
  inviteAccepted,
  invitePreview,
  type PortalProfile,
  type UpdatePortalProfileBody,
  type AcceptInviteBody,
  type InviteAccepted,
  type InvitePreview,
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
