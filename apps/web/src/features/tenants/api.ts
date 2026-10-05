import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  tenant,
  paged,
  inviteCreated,
  type Tenant,
  type CreateTenantBody,
  type UpdateTenantBody,
  type InviteCreated,
} from '@rms/contract';
import { ApiClientError, request } from '@/lib/api';

export const tenantsKeys = {
  all: ['tenants'] as const,
  list: () => [...tenantsKeys.all, 'list'] as const,
  detail: (id: string) => [...tenantsKeys.all, 'detail', id] as const,
};

const tenantList = paged(tenant);
type TenantList = z.infer<typeof tenantList>;

function tenantsUrl(cursor?: string) {
  if (!cursor) return routes.tenants.list();
  return `${routes.tenants.list()}?${new URLSearchParams({ cursor }).toString()}`;
}

export function useTenants() {
  return useInfiniteQuery<TenantList, ApiClientError>({
    queryKey: tenantsKeys.list(),
    queryFn: ({ pageParam, signal }) =>
      request(tenantsUrl(pageParam as string | undefined), { schema: tenantList, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useTenant(id: string) {
  return useQuery<Tenant, ApiClientError>({
    queryKey: tenantsKeys.detail(id),
    queryFn: ({ signal }) => request(routes.tenants.get(id), { schema: tenant, signal }),
    enabled: id.length > 0,
  });
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTenantBody) =>
      request(routes.tenants.create(), { method: 'POST', body, schema: tenant }),
    onSuccess: (created: Tenant) => {
      void queryClient.invalidateQueries({ queryKey: tenantsKeys.list() });
      queryClient.setQueryData(tenantsKeys.detail(created.id), created);
    },
  });
}

export function useUpdateTenant(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateTenantBody) =>
      request(routes.tenants.update(id), { method: 'PATCH', body, schema: tenant }),
    onSuccess: (updated: Tenant) => {
      void queryClient.invalidateQueries({ queryKey: tenantsKeys.list() });
      queryClient.setQueryData(tenantsKeys.detail(id), updated);
    },
  });
}

export function useDeleteTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request(routes.tenants.remove(id), { method: 'DELETE', schema: z.void() }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: tenantsKeys.list() });
      queryClient.removeQueries({ queryKey: tenantsKeys.detail(id) });
    },
  });
}

/**
 * Issues (or re-issues — "resend" is just "invite again") a portal invite.
 * The response's `url` is the raw invite link and is returned exactly once;
 * see `PortalAccessPanel` for how its lifetime is kept to "while the dialog
 * is open" and nowhere else.
 */
export function useInviteTenant(id: string) {
  const queryClient = useQueryClient();
  return useMutation<InviteCreated, ApiClientError, void>({
    mutationFn: () =>
      request(routes.tenants.invite(id), { method: 'POST', schema: inviteCreated }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenantsKeys.list() });
      void queryClient.invalidateQueries({ queryKey: tenantsKeys.detail(id) });
    },
  });
}

/** Unbinds the tenant's login and revokes any outstanding invite — the
 *  move-out kill switch. Also what "Revoke" does from the `invited` state. */
export function useRevokePortalAccess(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request(routes.tenants.revokePortalAccess(id), { method: 'DELETE', schema: z.void() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenantsKeys.list() });
      void queryClient.invalidateQueries({ queryKey: tenantsKeys.detail(id) });
    },
  });
}
