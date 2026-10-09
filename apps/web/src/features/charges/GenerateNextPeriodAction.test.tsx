import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes, type Charge, type LeaseDetail } from '@rms/contract';
import { GenerateNextPeriodAction } from './GenerateNextPeriodAction';

const now = '2026-01-01T00:00:00.000Z';
const leaseId = '00000000-0000-7000-8000-000000000001';

function baseLease(overrides: Partial<LeaseDetail> = {}): LeaseDetail {
  return {
    id: leaseId,
    chainId: '00000000-0000-7000-8000-000000000002',
    status: 'active',
    unitId: '00000000-0000-7000-8000-000000000003',
    unitLabel: 'Unit 1',
    propertyId: '00000000-0000-7000-8000-000000000004',
    propertyName: 'Maple St',
    propertyTimezone: 'UTC',
    calendar: 'gregorian',
    startDate: '2026-01-01',
    endDate: null,
    moveOutDate: null,
    rentCents: 100000,
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
    tenants: [],
    notes: null,
    unitStatus: 'occupied',
    propertyAddress: { line1: '1 Maple St', city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
    chain: [],
    rentSteps: [],
    ...overrides,
  };
}

function charge(overrides: Partial<Charge> & Pick<Charge, 'id' | 'generationKey'>): Charge {
  return {
    leaseId,
    type: 'rent',
    periodIndex: 0,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    occupiedStart: '2026-01-01',
    occupiedEnd: '2026-01-31',
    daysOccupied: 31,
    daysInPeriod: 31,
    dueDate: '2026-01-01',
    amountCents: 100000,
    isProrated: false,
    currency: 'USD',
    description: null,
    source: 'generated',
    supersedesChargeId: null,
    voidedAt: null,
    voidedReason: null,
    createdByUserId: null,
    createdAt: now,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

/** Stubs `GET /v1/leases/:id/charges` (the only endpoint this component reads from)
 *  to return the given set, regardless of query string — `useAllGeneratedRentCharges`
 *  walks every page itself. */
function stubCharges(existing: Charge[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === routes.leases.charges(leaseId)) {
        return jsonResponse({ items: existing, nextCursor: null });
      }
      return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
    }),
  );
}

function renderAction(lease: LeaseDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GenerateNextPeriodAction lease={lease} />
    </QueryClientProvider>,
  );
}

describe('GenerateNextPeriodAction — billing one period early, on purpose', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // "today" falls inside the January period (due 2026-01-01); the next period is
    // February, due 2026-02-01.
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('previews the next period and its amount before committing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubCharges([
      charge({ id: '00000000-0000-7000-8000-00000000000a', generationKey: '2026-01-01' }),
    ]);
    renderAction(baseLease());

    const trigger = await screen.findByRole('button', { name: /bill next period early/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    // The next period is February (the engine's own answer, not a guess) — shown
    // as a real date range rather than "next month", and its exact rent.
    expect(document.body.textContent).toMatch(/Feb 1, 2026.*Feb 28, 2026/);
    expect(document.body.textContent).toMatch(/\$1,000\.00/);
  });

  it('disables the action when the next period already has a charge', async () => {
    stubCharges([
      charge({ id: '00000000-0000-7000-8000-00000000000a', generationKey: '2026-01-01' }),
      // The next period (Feb) is already billed — written, voided, doesn't matter.
      charge({
        id: '00000000-0000-7000-8000-00000000000b',
        generationKey: '2026-02-01',
        periodStart: '2026-02-01',
        periodEnd: '2026-02-28',
        dueDate: '2026-02-01',
      }),
    ]);
    renderAction(baseLease());

    const trigger = await screen.findByRole('button', { name: /bill next period early/i });
    await waitFor(() => expect(trigger).toBeDisabled());
  });
});
