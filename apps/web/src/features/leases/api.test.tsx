import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { routes, type Lease } from '@rms/contract';
import { leasesKeys, useCreateLease, useRenewLease } from './api';

/**
 * Regression for docs/BUGS.md #5 — the lease page white-screened right after
 * creating a lease. `POST /v1/leases` (and `.../renew`) return the SUMMARY shape
 * (`lease`), which has no `tenants`/`chain`/`rentSteps`. Seeding that straight into
 * the DETAIL cache key used to make `LeaseRosterPanel` read `lease.tenants` as
 * `undefined` and crash on `.map()` the instant you navigated to the lease you'd
 * just made — reloading "fixed" it only because the real `GET` (parsed with
 * `leaseDetail`) then overwrote the cache.
 *
 * `leasesKeys.detail` is now tagged with `LeaseDetail`, which makes writing a bare
 * `Lease` there a compile error — this test is the runtime half: after creating or
 * renewing a lease, the detail cache must stay empty (so `useLease` fetches the
 * real detail shape) rather than hold an incomplete object.
 */

const now = new Date().toISOString();

function makeLeaseSummary(overrides: Partial<Lease> = {}): Lease {
  return {
    id: '11111111-1111-7111-8111-111111111111',
    chainId: '22222222-2222-7222-8222-222222222222',
    status: 'draft',
    unitId: '33333333-3333-7333-8333-333333333333',
    unitLabel: 'Unit 1',
    propertyId: '44444444-4444-7444-8444-444444444444',
    propertyName: 'Maple St',
    propertyTimezone: 'UTC',
    calendar: 'gregorian',
    startDate: '2026-01-01',
    endDate: null,
    moveOutDate: null,
    rentCents: 150000,
    currency: 'USD',
    rentFrequency: 'monthly',
    billingDay: 1,
    depositCents: 0,
    openingBalanceCents: 0,
    ledgerStartDate: '2026-01-01',
    moveOutBillingPolicy: 'bill_full_term',
    escalation: null,
    tenantCount: 1,
    primaryTenantName: 'Ada Lovelace',
    renewedFromLeaseId: null,
    endReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('leases api — the create/renew cache trap (docs/BUGS.md #5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('useCreateLease never seeds the detail cache with the summary POST returns', async () => {
    const created = makeLeaseSummary();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === routes.leases.create() && init?.method === 'POST') {
          return jsonResponse(created, 201);
        }
        return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCreateLease(), { wrapper: wrapperFor(queryClient) });

    result.current.mutate({
      unitId: created.unitId,
      tenantIds: ['55555555-5555-7555-8555-555555555555'],
      primaryTenantId: '55555555-5555-7555-8555-555555555555',
      startDate: created.startDate,
      rentCents: created.rentCents,
      rentFrequency: 'monthly',
      billingDay: 1,
      depositCents: 0,
      openingBalanceCents: 0,
      escalation: null,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The incomplete summary must never land under the detail key — if it did,
    // `LeaseRosterPanel` would read `tenants` as `undefined` and crash.
    expect(queryClient.getQueryData(leasesKeys.detail(created.id))).toBeUndefined();
  });

  it('useRenewLease never seeds the detail cache with the summary the renew route returns', async () => {
    const renewed = makeLeaseSummary({ id: '66666666-6666-7666-8666-666666666666' });
    const originalId = '77777777-7777-7777-8777-777777777777';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === routes.leases.renew(originalId) && init?.method === 'POST') {
          return jsonResponse(renewed, 201);
        }
        return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useRenewLease(originalId), { wrapper: wrapperFor(queryClient) });

    result.current.mutate({ startDate: '2027-01-01', rentCents: 150000 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(queryClient.getQueryData(leasesKeys.detail(renewed.id))).toBeUndefined();
  });
});
