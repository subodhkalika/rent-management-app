import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  lease,
  leaseDetail,
  leaseTenantSummary,
  paged,
  type Lease,
  type LeaseDetail,
  type LeaseTenantSummary,
  type CreateLeaseBody,
  type UpdateLeaseBody,
  type EndLeaseBody,
  type RenewLeaseBody,
  type CancelLeaseBody,
  type AddLeaseTenantBody,
  type RemoveLeaseTenantBody,
  type LeaseStatus,
} from '@rms/contract';
import { ApiClientError, request } from '@/lib/api';

export const leasesKeys = {
  all: ['leases'] as const,
  list: (filters: LeaseFilters) => [...leasesKeys.all, 'list', filters] as const,
  detail: (id: string) => [...leasesKeys.all, 'detail', id] as const,
};

export interface LeaseFilters {
  status?: LeaseStatus;
  unitId?: string;
  propertyId?: string;
  tenantId?: string;
}

const leaseList = paged(lease);
type LeaseList = z.infer<typeof leaseList>;

function leasesUrl(filters: LeaseFilters, cursor?: string) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.unitId) params.set('unitId', filters.unitId);
  if (filters.propertyId) params.set('propertyId', filters.propertyId);
  if (filters.tenantId) params.set('tenantId', filters.tenantId);
  if (cursor) params.set('cursor', cursor);
  const qs = params.toString();
  return qs ? `${routes.leases.list()}?${qs}` : routes.leases.list();
}

/** Paginates with the API's keyset cursor via `useInfiniteQuery`, same pattern as
 *  `useProperties` / `useTenants` / `useUnits`. */
export function useLeases(filters: LeaseFilters = {}) {
  return useInfiniteQuery<LeaseList, ApiClientError>({
    queryKey: leasesKeys.list(filters),
    queryFn: ({ pageParam, signal }) =>
      request(leasesUrl(filters, pageParam as string | undefined), { schema: leaseList, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useLease(id: string) {
  return useQuery<LeaseDetail, ApiClientError>({
    queryKey: leasesKeys.detail(id),
    queryFn: ({ signal }) => request(routes.leases.get(id), { schema: leaseDetail, signal }),
    enabled: id.length > 0,
  });
}

function invalidateLease(queryClient: ReturnType<typeof useQueryClient>, updated: Lease) {
  void queryClient.invalidateQueries({ queryKey: leasesKeys.all });
  queryClient.setQueryData(leasesKeys.detail(updated.id), (prev: LeaseDetail | undefined) =>
    prev ? { ...prev, ...updated } : prev,
  );
  // Unit occupancy and property unit counts can change on activate/end/renew.
  void queryClient.invalidateQueries({ queryKey: ['units'] });
  void queryClient.invalidateQueries({ queryKey: ['properties'] });
  // Activate and end both run the generator synchronously (docs/PLAN-PHASE3A.md
  // §0 decision 10) — the Charges tab's data is stale the instant either succeeds.
  void queryClient.invalidateQueries({ queryKey: ['charges'] });
}

export function useCreateLease() {
  const queryClient = useQueryClient();
  return useMutation<Lease, ApiClientError, CreateLeaseBody>({
    mutationFn: (body) => request(routes.leases.create(), { method: 'POST', body, schema: lease }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: leasesKeys.all });
      queryClient.setQueryData(leasesKeys.detail(created.id), created);
    },
  });
}

export function useUpdateLease(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Lease, ApiClientError, UpdateLeaseBody>({
    mutationFn: (body) => request(routes.leases.update(id), { method: 'PATCH', body, schema: lease }),
    onSuccess: (updated) => invalidateLease(queryClient, updated),
  });
}

export function useActivateLease(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Lease, ApiClientError, void>({
    mutationFn: () => request(routes.leases.activate(id), { method: 'POST', schema: lease }),
    onSuccess: (updated) => invalidateLease(queryClient, updated),
  });
}

export function useCancelLease(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Lease, ApiClientError, CancelLeaseBody>({
    mutationFn: (body) => request(routes.leases.cancel(id), { method: 'POST', body, schema: lease }),
    onSuccess: (updated) => invalidateLease(queryClient, updated),
  });
}

export function useEndLease(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Lease, ApiClientError, EndLeaseBody>({
    mutationFn: (body) => request(routes.leases.end(id), { method: 'POST', body, schema: lease }),
    onSuccess: (updated) => invalidateLease(queryClient, updated),
  });
}

export function useRenewLease(id: string) {
  const queryClient = useQueryClient();
  return useMutation<Lease, ApiClientError, RenewLeaseBody>({
    mutationFn: (body) => request(routes.leases.renew(id), { method: 'POST', body, schema: lease }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: leasesKeys.all });
      queryClient.setQueryData(leasesKeys.detail(created.id), created);
      void queryClient.invalidateQueries({ queryKey: ['units'] });
      void queryClient.invalidateQueries({ queryKey: ['properties'] });
    },
  });
}

export function useDeleteLease() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiClientError, string>({
    mutationFn: (id) => request(routes.leases.remove(id), { method: 'DELETE', schema: z.void() }),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: leasesKeys.all });
      queryClient.removeQueries({ queryKey: leasesKeys.detail(id) });
    },
  });
}

export function useAddLeaseTenant(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<LeaseTenantSummary, ApiClientError, AddLeaseTenantBody>({
    mutationFn: (body) =>
      request(routes.leases.addTenant(leaseId), { method: 'POST', body, schema: leaseTenantSummary }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leasesKeys.detail(leaseId) });
      void queryClient.invalidateQueries({ queryKey: leasesKeys.all });
    },
  });
}

export function useRemoveLeaseTenant(leaseId: string, tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation<LeaseTenantSummary, ApiClientError, RemoveLeaseTenantBody>({
    mutationFn: (body) =>
      request(routes.leases.removeTenant(leaseId, tenantId), {
        method: 'POST',
        body,
        schema: leaseTenantSummary,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leasesKeys.detail(leaseId) });
      void queryClient.invalidateQueries({ queryKey: leasesKeys.all });
    },
  });
}

export function useSetPrimaryTenant(leaseId: string, tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation<LeaseTenantSummary, ApiClientError, void>({
    mutationFn: () =>
      request(routes.leases.setPrimaryTenant(leaseId, tenantId), {
        method: 'POST',
        schema: leaseTenantSummary,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: leasesKeys.detail(leaseId) });
      void queryClient.invalidateQueries({ queryKey: leasesKeys.all });
    },
  });
}
