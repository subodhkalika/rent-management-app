import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes, type PortalCharge } from '@rms/contract';
import { PortalChargesPanel } from './PortalChargesPanel';

const leaseId = '00000000-0000-7000-8000-000000000001';

function portalCharge(overrides: Partial<PortalCharge> & Pick<PortalCharge, 'id'>): PortalCharge {
  return {
    leaseId,
    type: 'rent',
    description: null,
    periodStart: null,
    periodEnd: null,
    daysOccupied: null,
    daysInPeriod: null,
    isProrated: false,
    dueDate: '2026-01-01',
    amountCents: 100000,
    currency: 'USD',
    isVoided: false,
    supersedesChargeId: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PortalChargesPanel leaseId={leaseId} calendar="gregorian" currency="USD" />
    </QueryClientProvider>,
  );
}

describe('PortalChargesPanel — the tenant statement, never a total', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('empty: explains that nothing has been charged yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === routes.portal.leaseCharges(leaseId)) return jsonResponse({ items: [], nextCursor: null });
        return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
      }),
    );
    renderPanel();
    expect(await screen.findByText(/nothing has been charged yet/i)).toBeInTheDocument();
  });

  it('a prorated row shows "17 of 31 days", and a voided row is struck through — with no total anywhere', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === routes.portal.leaseCharges(leaseId)) {
          return jsonResponse({
            items: [
              portalCharge({
                id: '00000000-0000-7000-8000-00000000000a',
                isProrated: true,
                daysOccupied: 17,
                daysInPeriod: 31,
                periodStart: '2026-01-15',
                periodEnd: '2026-01-31',
                amountCents: 54839,
              }),
              portalCharge({
                id: '00000000-0000-7000-8000-00000000000b',
                isVoided: true,
                amountCents: 90000,
                description: 'Old amount',
              }),
            ],
            nextCursor: null,
          });
        }
        return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
      }),
    );

    renderPanel();

    expect(await screen.findByText('17 of 31 days')).toBeInTheDocument();
    const voidedAmount = screen.getByText('$900.00');
    expect(voidedAmount.className).toContain('line-through');
    expect(screen.getByText(/voided/i)).toBeInTheDocument();

    // No total anywhere — not the sum of the two rows, not either amount repeated
    // as a running figure.
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument();
    expect(screen.queryByText('$1,448.39')).not.toBeInTheDocument();
  });
});
