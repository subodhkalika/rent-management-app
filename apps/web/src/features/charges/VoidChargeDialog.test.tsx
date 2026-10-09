import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes, type Charge } from '@rms/contract';
import { VoidChargeDialog } from './VoidChargeDialog';

const leaseId = '00000000-0000-7000-8000-000000000001';

const testCharge: Charge = {
  id: '00000000-0000-7000-8000-00000000000a',
  leaseId,
  type: 'rent',
  generationKey: '2026-01-01',
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
  createdAt: '2026-01-01T00:00:00.000Z',
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
        <VoidChargeDialog open onOpenChange={onOpenChange} leaseId={leaseId} charge={testCharge} calendar="gregorian" />
      </QueryClientProvider>,
    ),
  };
}

describe('VoidChargeDialog — the mandatory, >=10 character reason', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to submit a reason shorter than 10 characters, with the contract\'s own message', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/reason/i), 'too short');
    await user.click(screen.getByRole('button', { name: /void charge/i }));

    expect(await screen.findByText(/say why in a sentence/i)).toBeInTheDocument();
  });

  it('submits the reason and closes on success', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      expect(url.pathname).toBe(routes.leases.voidCharge(leaseId, testCharge.id));
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ reason: 'Duplicate charge, entered twice by mistake' });
      return jsonResponse({ ...testCharge, voidedAt: '2026-01-02T00:00:00.000Z', voidedReason: 'Duplicate charge, entered twice by mistake' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(/reason/i), 'Duplicate charge, entered twice by mistake');
    await user.click(screen.getByRole('button', { name: /void charge/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no charge is selected — the dialog is not reachable without one', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <VoidChargeDialog open onOpenChange={vi.fn()} leaseId={leaseId} charge={null} calendar="gregorian" />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
