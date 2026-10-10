import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes, type Payment } from '@rms/contract';
import { VoidPaymentDialog } from './VoidPaymentDialog';

const leaseId = '00000000-0000-7000-8000-000000000001';

const testPayment: Payment = {
  id: '00000000-0000-7000-8000-00000000000a',
  leaseId,
  kind: 'payment',
  method: 'cheque',
  amountCents: 100000,
  currency: 'USD',
  receivedOn: '2026-01-05',
  reference: '1234',
  note: null,
  supersedesPaymentId: null,
  voidedAt: null,
  voidedReason: null,
  recordedByUserId: 'user-1',
  createdAt: '2026-01-05T00:00:00.000Z',
  updatedAt: '2026-01-05T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onOpenChange,
    ...render(
      <QueryClientProvider client={queryClient}>
        <VoidPaymentDialog open onOpenChange={onOpenChange} leaseId={leaseId} payment={testPayment} calendar="gregorian" />
      </QueryClientProvider>,
    ),
  };
}

/**
 * Pins docs/PLAN-PHASE3B.md §4.7 / decision 5: void means "this never happened,
 * or I recorded it wrong" — a bounced cheque. Refund means "it happened and I
 * sent money back". The dialog says so in those words, not a tooltip, because
 * getting this backwards is the one way the ledger can lie.
 */
describe('VoidPaymentDialog — the void/refund distinction, said in plain words', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('states the void/refund rule verbatim, and points at "refund" as the alternative', () => {
    renderDialog();

    expect(screen.getByText(/void means this never happened, or you recorded it wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/refund/i)).toBeInTheDocument();
    expect(screen.getByText(/means it happened and you sent money back/i)).toBeInTheDocument();
  });

  it('refuses to submit a reason shorter than 10 characters, with the contract\'s own message', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/reason/i), 'too short');
    await user.click(screen.getByRole('button', { name: /void payment/i }));

    expect(await screen.findByText(/say why in a sentence/i)).toBeInTheDocument();
  });

  it('submits the reason to the void route and closes on success', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      expect(url.pathname).toBe(routes.leases.voidPayment(leaseId, testPayment.id));
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Cheque bounced, bank confirmed by phone' });
      return jsonResponse({ ...testPayment, voidedAt: '2026-01-06T00:00:00.000Z', voidedReason: 'Cheque bounced, bank confirmed by phone' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(/reason/i), 'Cheque bounced, bank confirmed by phone');
    await user.click(screen.getByRole('button', { name: /void payment/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no payment is selected — the dialog is not reachable without one', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <VoidPaymentDialog open onOpenChange={vi.fn()} leaseId={leaseId} payment={null} calendar="gregorian" />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
