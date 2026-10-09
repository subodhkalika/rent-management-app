import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  charge,
  chargeWithLease,
  paged,
  type Charge,
  type ChargeWithLease,
  type ChargeListQuery,
  type OrgChargeListQuery,
  type CreateChargeBody,
  type VoidChargeBody,
  type CorrectChargeBody,
} from '@rms/contract';
import { ApiClientError, request } from '@/lib/api';

export const chargesKeys = {
  all: ['charges'] as const,
  leaseList: (leaseId: string, filters: Partial<ChargeListQuery>) =>
    [...chargesKeys.all, 'lease', leaseId, filters] as const,
  orgList: (filters: Partial<OrgChargeListQuery>) => [...chargesKeys.all, 'org', filters] as const,
};

const chargeList = paged(charge);
type ChargeList = z.infer<typeof chargeList>;
const chargeWithLeaseList = paged(chargeWithLease);
type ChargeWithLeaseList = z.infer<typeof chargeWithLeaseList>;

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function leaseChargesUrl(leaseId: string, filters: Partial<ChargeListQuery>, cursor?: string) {
  return `${routes.leases.charges(leaseId)}${buildQueryString({ ...filters, cursor })}`;
}

/** Ordered by due date (the server's own `ORDER BY due_date, id`, never re-sorted
 *  client-side) — see `GET /v1/leases/:id/charges` in docs/PLAN-PHASE3A.md §9.1. */
export function useLeaseCharges(leaseId: string, filters: Partial<ChargeListQuery> = {}) {
  return useInfiniteQuery<ChargeList, ApiClientError>({
    queryKey: chargesKeys.leaseList(leaseId, filters),
    queryFn: ({ pageParam, signal }) =>
      request(leaseChargesUrl(leaseId, filters, pageParam as string | undefined), {
        schema: chargeList,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: leaseId.length > 0,
  });
}

/**
 * Every generated rent charge for a lease, VOIDED ONES INCLUDED, across every page.
 *
 * `includeVoided: true` here is load-bearing, not a default left alone.
 * `diffChargesAgainstSchedule` needs voided rows to tell an occupied generation key
 * from a genuinely missing one — `charge_generation_uq` has no predicate on
 * `voided_at`, so a voided row's key can never be refilled by the generator, and a
 * period whose only row is voided is *handled*, not missing. Request
 * `includeVoided: false` here and every corrected period reports `missing` forever,
 * offering a "Run generation" action guaranteed to write nothing — see
 * `diffChargesAgainstSchedule`'s own doc comment and `docs/PLAN-PHASE3A.md`.
 * `api.includeVoided.test.ts` pins this.
 *
 * The drift banner must also see the WHOLE set or it reports false "missing" rows
 * for periods on a page it hasn't fetched yet — so this walks pages until exhausted
 * rather than rendering the first page alone. Bounded by `MAX_SCHEDULE_PERIODS`
 * (600; at most ~6 pages at the API's max page size of 100), so this terminates.
 */
export function useAllGeneratedRentCharges(leaseId: string) {
  const filters: Partial<ChargeListQuery> = { type: 'rent', includeVoided: true, limit: 100 };
  const query = useInfiniteQuery<ChargeList, ApiClientError>({
    queryKey: chargesKeys.leaseList(leaseId, filters),
    queryFn: ({ pageParam, signal }) =>
      request(leaseChargesUrl(leaseId, filters, pageParam as string | undefined), {
        schema: chargeList,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: leaseId.length > 0,
  });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const allPagesLoaded = !!query.data && !query.hasNextPage;
  // Defensive filter, not a parallel rule: a manual rent charge is rejected 422 by
  // the API (§9.1), so `source !== 'generated'` should never appear here — but the
  // diff function's own contract requires generated-only input, and filtering costs
  // nothing.
  const charges: Charge[] | undefined = allPagesLoaded
    ? query.data!.pages.flatMap((p) => p.items).filter((c) => c.source === 'generated')
    : undefined;

  return {
    charges,
    isPending: query.isPending || (!!query.data && !allPagesLoaded),
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

function invalidateLeaseCharges(queryClient: ReturnType<typeof useQueryClient>, leaseId: string) {
  void queryClient.invalidateQueries({ queryKey: [...chargesKeys.all, 'lease', leaseId] });
}

export function useGenerateCharges(leaseId: string) {
  const queryClient = useQueryClient();
  const responseSchema = z.object({ created: z.array(charge) });
  return useMutation<{ created: Charge[] }, ApiClientError, void>({
    mutationFn: () =>
      request(routes.leases.generateCharges(leaseId), { method: 'POST', schema: responseSchema }),
    onSuccess: () => invalidateLeaseCharges(queryClient, leaseId),
  });
}

/**
 * The landlord's deliberate "bill one period early" action — same response shape
 * as `useGenerateCharges`, just against `generate-next-period` instead of
 * `generate`. Repeating this writes nothing new once the key is taken, same as the
 * route it calls.
 */
export function useGenerateNextPeriodCharge(leaseId: string) {
  const queryClient = useQueryClient();
  const responseSchema = z.object({ created: z.array(charge) });
  return useMutation<{ created: Charge[] }, ApiClientError, void>({
    mutationFn: () =>
      request(routes.leases.generateNextPeriod(leaseId), { method: 'POST', schema: responseSchema }),
    onSuccess: () => invalidateLeaseCharges(queryClient, leaseId),
  });
}

export function useCreateManualCharge(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<Charge, ApiClientError, CreateChargeBody>({
    mutationFn: (body) =>
      request(routes.leases.charges(leaseId), { method: 'POST', body, schema: charge }),
    onSuccess: () => invalidateLeaseCharges(queryClient, leaseId),
  });
}

export function useVoidCharge(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<Charge, ApiClientError, { chargeId: string; body: VoidChargeBody }>({
    mutationFn: ({ chargeId, body }) =>
      request(routes.leases.voidCharge(leaseId, chargeId), { method: 'POST', body, schema: charge }),
    onSuccess: () => invalidateLeaseCharges(queryClient, leaseId),
  });
}

export function useCorrectCharge(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<Charge, ApiClientError, { chargeId: string; body: CorrectChargeBody }>({
    mutationFn: ({ chargeId, body }) =>
      request(routes.leases.correctCharge(leaseId, chargeId), { method: 'POST', body, schema: charge }),
    onSuccess: () => invalidateLeaseCharges(queryClient, leaseId),
  });
}

/* ======================================================================== */
/* portfolio-wide                                                            */
/* ======================================================================== */

function orgChargesUrl(filters: Partial<OrgChargeListQuery>, cursor?: string) {
  return `${routes.charges.list()}${buildQueryString({ ...filters, cursor })}`;
}

export function useOrgCharges(filters: Partial<OrgChargeListQuery> = {}) {
  return useInfiniteQuery<ChargeWithLeaseList, ApiClientError>({
    queryKey: chargesKeys.orgList(filters),
    queryFn: ({ pageParam, signal }) =>
      request(orgChargesUrl(filters, pageParam as string | undefined), {
        schema: chargeWithLeaseList,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export type { Charge, ChargeWithLease };
