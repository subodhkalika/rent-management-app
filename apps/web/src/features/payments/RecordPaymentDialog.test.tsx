import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes, type LeaseDetail, type LedgerResponse, type Payment } from '@rms/contract';
import { RecordPaymentDialog } from './RecordPaymentDialog';

const leaseId = '00000000-0000-7000-8000-000000000001';
const now = '2026-01-01T00:00:00.000Z';

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
    depositCents: 50000,
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

const existingPayment: Payment = {
  id: '00000000-0000-7000-8000-0000000000aa',
  leaseId,
  kind: 'payment',
  method: 'bank_transfer',
  amountCents: 50000,
  currency: 'USD',
  receivedOn: '2026-03-03',
  reference: null,
  note: null,
  supersedesPaymentId: null,
  voidedAt: null,
  voidedReason: null,
  recordedByUserId: 'user-1',
  createdAt: '2026-03-03T00:00:00.000Z',
  updatedAt: '2026-03-03T00:00:00.000Z',
};

function ledgerFixture(): LedgerResponse {
  return {
    chainId: '00000000-0000-7000-8000-000000000002',
    currency: 'USD',
    asOfDate: '2026-03-15',
    leases: [{ leaseId, startDate: '2026-01-01', endDate: null, isCurrent: true }],
    entries: [
      {
        kind: 'payment',
        leaseId,
        effectiveDate: existingPayment.receivedOn,
        runningBalanceCents: 0,
        payment: existingPayment,
      },
    ],
    balance: {
      chainId: '00000000-0000-7000-8000-000000000002',
      currency: 'USD',
      asOfDate: '2026-03-15',
      chargedCents: 50000,
      paidCents: 50000,
      outstandingCents: 0,
      creditCents: 0,
      balanceCents: 0,
      arrearsCents: 0,
      depositOutstandingCents: 0,
      rentOutstandingCents: 0,
      oldestOverdueDueDate: null,
    },
    truncated: false,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function stubFetch(ledger: LedgerResponse, onPost: (body: unknown) => unknown) {
  const fetchMock = vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if ((init?.method ?? 'GET') === 'GET' && url.pathname === routes.leases.ledger(leaseId)) {
      return jsonResponse(ledger);
    }
    if (init?.method === 'POST' && url.pathname === routes.leases.payments(leaseId)) {
      return jsonResponse(onPost(JSON.parse(String(init.body))));
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDialog(lease: LeaseDetail, onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onOpenChange,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RecordPaymentDialog open onOpenChange={onOpenChange} lease={lease} />
      </QueryClientProvider>,
    ),
  };
}

/**
 * docs/PLAN-PHASE3B.md §2.5 (future dates blocked) and §4.15 (the duplicate
 * confirm) — the two behaviours this dialog owns beyond a plain form.
 */
describe('RecordPaymentDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('blocks a future-dated payment client-side, without ever calling the API', async () => {
    const fetchMock = stubFetch(ledgerFixture(), () => {
      throw new Error('should not record a future-dated payment');
    });
    const user = userEvent.setup();
    renderDialog(baseLease());

    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '500.00');
    fireEvent.change(screen.getByLabelText('Date received'), { target: { value: '2026-04-01' } });
    await user.click(screen.getByRole('button', { name: /^record payment$/i }));

    expect(await screen.findByText(/can't be dated in the future/i)).toBeInTheDocument();
    const postCalls = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('asks for confirmation before recording a payment that matches one already on the chain, then sends it on "record anyway"', async () => {
    const fetchMock = stubFetch(ledgerFixture(), (body) => ({ ...existingPayment, id: '00000000-0000-7000-8000-0000000000bb', ...(body as object) }));
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(baseLease());

    // Same amount, date and (default) method/kind as `existingPayment` above.
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '500.00');
    fireEvent.change(screen.getByLabelText('Date received'), { target: { value: '2026-03-03' } });
    await user.click(screen.getByRole('button', { name: /^record payment$/i }));

    expect(await screen.findByRole('heading', { name: /record this again/i })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);

    await user.click(screen.getByRole('button', { name: /record it anyway/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeDefined();
    const [, postInit] = postCall!;
    expect(JSON.parse(String((postInit as RequestInit).body))).toMatchObject({
      amountCents: 50000,
      receivedOn: '2026-03-03',
      method: 'bank_transfer',
      kind: 'payment',
    });
  });
});
