import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { routes } from '@rms/contract';
import { useAllGeneratedRentCharges } from './api';

/**
 * Pins `includeVoided: true` on the drift banner's "every page" query.
 *
 * This is not a default left alone — it is load-bearing. `diffChargesAgainstSchedule`
 * needs voided rows to tell an occupied generation key from a genuinely missing one
 * (docs/PLAN-PHASE3A.md; contract commit d09f11a, "Stop reporting a corrected period
 * as missing forever"). `includeVoided: false` here used to work only because a
 * separate contract bug (`z.coerce.boolean()`, fixed at 835b80e) made the flag
 * impossible to honour — two bugs cancelling. Flip this back to `false` and every
 * corrected period reports `missing` forever, with a "Run generation" action
 * guaranteed to write nothing. This test fails the moment someone does.
 */
describe('useAllGeneratedRentCharges — includeVoided must stay true', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests includeVoided=true, never false', async () => {
    const leaseId = '00000000-0000-7000-8000-000000000001';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useAllGeneratedRentCharges(leaseId), { wrapper });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    const url = new URL(calledUrl, 'http://localhost');
    expect(url.pathname).toBe(routes.leases.charges(leaseId));
    expect(url.searchParams.get('includeVoided')).toBe('true');
  });
});
