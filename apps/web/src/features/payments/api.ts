import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  routes,
  payment,
  ledgerResponse,
  leaseBalanceResponse,
  arrearsResponse,
  paged,
  type Payment,
  type LedgerResponse,
  type LeaseBalanceResponse,
  type ArrearsResponse,
  type ArrearsQuery,
  type PaymentListQuery,
  type RecordPaymentBody,
  type VoidPaymentBody,
  type CorrectPaymentBody,
  type UpdatePaymentNoteBody,
} from '@rms/contract';
import { ApiClientError, request } from '@/lib/api';

/**
 * Payments, the ledger and balances for one lease (chain, really — see
 * docs/PLAN-PHASE3B.md §3.1). A payment recorded against any lease in a chain is
 * the same money, so every mutation here invalidates the ledger and balance for the
 * lease id on screen, plus the org-wide arrears list (cheap, and a payment can move
 * a chain off that page entirely).
 */

export const paymentsKeys = {
  all: ['payments'] as const,
  leaseList: (leaseId: string, filters: Partial<PaymentListQuery>) =>
    [...paymentsKeys.all, 'lease', leaseId, filters] as const,
};

export const ledgerKeys = {
  all: ['ledger'] as const,
  lease: (leaseId: string) => [...ledgerKeys.all, leaseId] as const,
};

export const balanceKeys = {
  all: ['balance'] as const,
  lease: (leaseId: string) => [...balanceKeys.all, leaseId] as const,
};

export const arrearsKeys = {
  all: ['arrears'] as const,
  list: (filters: Partial<ArrearsQuery>) => [...arrearsKeys.all, filters] as const,
};

const paymentList = paged(payment);
type PaymentList = z.infer<typeof paymentList>;

function buildQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function leasePaymentsUrl(leaseId: string, filters: Partial<PaymentListQuery>, cursor?: string) {
  return `${routes.leases.payments(leaseId)}${buildQueryString({ ...filters, cursor })}`;
}

export function useLeasePayments(leaseId: string, filters: Partial<PaymentListQuery> = {}) {
  return useInfiniteQuery<PaymentList, ApiClientError>({
    queryKey: paymentsKeys.leaseList(leaseId, filters),
    queryFn: ({ pageParam, signal }) =>
      request(leasePaymentsUrl(leaseId, filters, pageParam as string | undefined), {
        schema: paymentList,
        signal,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: leaseId.length > 0,
  });
}

/** The whole chain, interleaved — see `ledgerResponse` in the contract. */
export function useLeaseLedger(leaseId: string) {
  return useQuery<LedgerResponse, ApiClientError>({
    queryKey: ledgerKeys.lease(leaseId),
    queryFn: ({ signal }) => request(routes.leases.ledger(leaseId), { schema: ledgerResponse, signal }),
    enabled: leaseId.length > 0,
  });
}

export function useLeaseBalance(leaseId: string) {
  return useQuery<LeaseBalanceResponse, ApiClientError>({
    queryKey: balanceKeys.lease(leaseId),
    queryFn: ({ signal }) => request(routes.leases.balance(leaseId), { schema: leaseBalanceResponse, signal }),
    enabled: leaseId.length > 0,
  });
}

function invalidateLeaseMoney(queryClient: ReturnType<typeof useQueryClient>, leaseId: string) {
  void queryClient.invalidateQueries({ queryKey: [...paymentsKeys.all, 'lease', leaseId] });
  void queryClient.invalidateQueries({ queryKey: ledgerKeys.lease(leaseId) });
  void queryClient.invalidateQueries({ queryKey: balanceKeys.lease(leaseId) });
  void queryClient.invalidateQueries({ queryKey: arrearsKeys.all });
}

export function useRecordPayment(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<Payment, ApiClientError, RecordPaymentBody>({
    mutationFn: (body) => request(routes.leases.payments(leaseId), { method: 'POST', body, schema: payment }),
    onSuccess: () => invalidateLeaseMoney(queryClient, leaseId),
  });
}

export function useVoidPayment(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<Payment, ApiClientError, { paymentId: string; body: VoidPaymentBody }>({
    mutationFn: ({ paymentId, body }) =>
      request(routes.leases.voidPayment(leaseId, paymentId), { method: 'POST', body, schema: payment }),
    onSuccess: () => invalidateLeaseMoney(queryClient, leaseId),
  });
}

export function useCorrectPayment(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<Payment, ApiClientError, { paymentId: string; body: CorrectPaymentBody }>({
    mutationFn: ({ paymentId, body }) =>
      request(routes.leases.correctPayment(leaseId, paymentId), { method: 'POST', body, schema: payment }),
    onSuccess: () => invalidateLeaseMoney(queryClient, leaseId),
  });
}

export function useUpdatePaymentNote(leaseId: string) {
  const queryClient = useQueryClient();
  return useMutation<Payment, ApiClientError, { paymentId: string; body: UpdatePaymentNoteBody }>({
    mutationFn: ({ paymentId, body }) =>
      request(routes.leases.updatePaymentNote(leaseId, paymentId), { method: 'PATCH', body, schema: payment }),
    onSuccess: () => invalidateLeaseMoney(queryClient, leaseId),
  });
}

/* ======================================================================== */
/* arrears — portfolio-wide                                                  */
/* ======================================================================== */

function arrearsUrl(filters: Partial<ArrearsQuery>) {
  return `${routes.arrears.list()}${buildQueryString({ ...filters })}`;
}

export function useArrears(filters: Partial<ArrearsQuery> = {}) {
  return useQuery<ArrearsResponse, ApiClientError>({
    queryKey: arrearsKeys.list(filters),
    queryFn: ({ signal }) => request(arrearsUrl(filters), { schema: arrearsResponse, signal }),
  });
}

export type { Payment };
