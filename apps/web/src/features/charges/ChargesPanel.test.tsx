import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routes, type Charge, type LeaseDetail } from '@rms/contract';
import { ChargesPanel } from './ChargesPanel';

const now = '2026-01-01T00:00:00.000Z';

function baseLease(overrides: Partial<LeaseDetail> = {}): LeaseDetail {
  return {
    id: '00000000-0000-7000-8000-000000000001',
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
    leaseId: '00000000-0000-7000-8000-000000000001',
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

function renderPanel(lease: LeaseDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChargesPanel lease={lease} />
    </QueryClientProvider>,
  );
}

describe('ChargesPanel — the four states', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loading: shows a skeleton, not a spinner, before data arrives', () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));
    const lease = baseLease();
    renderPanel(lease);
    expect(screen.getByLabelText(/loading charges/i)).toBeInTheDocument();
  });

  it('error: says what failed and offers a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'internal', message: 'Database unavailable' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const lease = baseLease();
    renderPanel(lease);

    // Both the table's own fetch and the drift banner's fetch hit the same (failing)
    // stub, so each shows its own error+retry independently — hence `getAllBy`.
    expect(await screen.findByText(/couldn't load charges/i)).toBeInTheDocument();
    expect(screen.getAllByText(/database unavailable/i).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /try again/i }).length).toBeGreaterThan(0);
  });

  it('empty: explains what a charge is and offers the actions that create the first one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === routes.leases.charges('00000000-0000-7000-8000-000000000001')) {
          return jsonResponse({ items: [], nextCursor: null });
        }
        return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
      }),
    );
    const lease = baseLease();
    renderPanel(lease);

    expect(await screen.findByText(/no charges yet/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /generate charges/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /add charge/i }).length).toBeGreaterThan(0);
  });

  it('loaded: overdue is highlighted, and a voided row is struck through with its successor linked', async () => {
    const leaseId = '00000000-0000-7000-8000-000000000001';
    const original = charge({
      id: '00000000-0000-7000-8000-00000000000a',
      generationKey: '2026-01-01',
      amountCents: 90000,
      dueDate: '2026-01-01', // before "today" (2026-01-15) — overdue, but this row is voided below
      voidedAt: '2026-01-10T00:00:00.000Z',
      voidedReason: 'Rent step corrected',
    });
    const successor = charge({
      id: '00000000-0000-7000-8000-00000000000b',
      generationKey: null,
      source: 'manual',
      amountCents: 100000,
      dueDate: '2026-01-01',
      supersedesChargeId: original.id,
    });
    const stillDue = charge({
      id: '00000000-0000-7000-8000-00000000000c',
      generationKey: '2026-02-01',
      amountCents: 100000,
      dueDate: '2026-02-01',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === routes.leases.charges(leaseId)) {
          // Match the REAL server's `includeVoided` semantics (post-835b80e):
          // only the literal string "true" returns voided rows; anything else —
          // absent, or any other value — excludes them. Checking for the inverse
          // ("false" means filtered) is exactly the more-lenient-than-production
          // mock shape that let the real includeVoided:false regression hide
          // behind a green suite before.
          const includeVoided = url.searchParams.get('includeVoided') === 'true';
          const all = [original, successor, stillDue];
          const visible = includeVoided ? all : all.filter((c) => c.voidedAt === null);
          return jsonResponse({ items: visible, nextCursor: null });
        }
        return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
      }),
    );

    const lease = baseLease({ id: leaseId });
    renderPanel(lease);

    await waitFor(() => expect(screen.getByText('$900.00')).toBeInTheDocument());

    // The voided row's own amount is struck through (checked via its cell class)…
    const voidedAmountCell = screen.getByText('$900.00');
    expect(voidedAmountCell.className).toContain('line-through');

    // …and it links to what superseded it, rather than just vanishing.
    expect(screen.getByText(/superseded/i)).toBeInTheDocument();

    // The SUCCESSOR (due Jan 1, not voided) is genuinely overdue relative to
    // "today" (2026-01-15) — exactly one Overdue badge, on that row. The voided
    // original is excluded from the overdue check entirely (it is struck through,
    // not flagged), and February is not due yet.
    expect(screen.getAllByText(/overdue/i)).toHaveLength(1);
  });

  it.each(['draft', 'cancelled'] as const)(
    'suppresses the drift banner entirely on a %s lease — nothing has ever been generated, and Run generation would 409',
    async (status) => {
      const leaseId = '00000000-0000-7000-8000-000000000001';
      // Onboarding a six-month-old tenancy (the exact scenario PLAN-PHASE3A names):
      // the schedule already wants several periods, but this lease has never been
      // activated, so no charge row exists for any of them.
      const lease = baseLease({ id: leaseId, status, startDate: '2025-06-15', ledgerStartDate: '2025-06-15' });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((input: string | URL) => {
          const url = new URL(String(input), 'http://localhost');
          if (url.pathname === routes.leases.charges(leaseId)) return jsonResponse({ items: [], nextCursor: null });
          return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
        }),
      );

      renderPanel(lease);

      expect(await screen.findByText(/no charges yet/i)).toBeInTheDocument();
      expect(screen.queryByText(/charges need review/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/period has no charge yet/i)).not.toBeInTheDocument();
    },
  );
});
