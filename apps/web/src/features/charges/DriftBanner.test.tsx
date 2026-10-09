import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { routes, type Charge, type LeaseDetail } from '@rms/contract';
import { DriftBanner } from './DriftBanner';

/*
 * NOTE on fixtures: the contract ships `chargeDriftFixtures` in
 * `packages/contract/src/charge.fixtures.ts` precisely so the API and the web app
 * assert the same worked examples. That file is NOT re-exported from
 * `packages/contract/src/index.ts` (no `export * from './charge.fixtures.js'`),
 * and the package's `exports` map only publishes `.` — so `@rms/contract/charge.fixtures.js`
 * 404s at resolution time (confirmed: Vite raises "Missing './charge.fixtures.js'
 * specifier"). This is a contract gap, reported upward rather than worked around
 * with a parallel type. Until it is fixed, these tests build their own literal
 * `Charge`/lease fixtures and exercise the real, exported `diffChargesAgainstSchedule`
 * (via `DriftBanner`) against them — covering the same four drift kinds the
 * contract's own fixtures name, just not asserting byte-for-byte against that file.
 */

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

function stubFetch(leaseId: string, charges: Charge[], onGenerate?: () => Charge[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === routes.leases.charges(leaseId) && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ items: charges, nextCursor: null });
      }
      if (url.pathname === routes.leases.generateCharges(leaseId) && init?.method === 'POST') {
        return jsonResponse({ created: onGenerate ? onGenerate() : [] });
      }
      return jsonResponse({ error: { code: 'not_found', message: `No stub for ${url.pathname}` } }, 404);
    }),
  );
}

function renderBanner(lease: LeaseDetail, onReviewCharge = vi.fn(), onVoidCharge = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onReviewCharge,
    onVoidCharge,
    ...render(
      <QueryClientProvider client={queryClient}>
        <DriftBanner lease={lease} onReviewCharge={onReviewCharge} onVoidCharge={onVoidCharge} />
        <Toaster />
      </QueryClientProvider>,
    ),
  };
}

describe('DriftBanner — the only thing that makes a written charge disagreeing with the live schedule visible', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Mid-January: `chargesDueForGeneration` (today + 31d horizon) reaches exactly
    // the January and February rent periods for a plain monthly lease starting
    // 2026-01-01 — the fixed, known "planned" set every case below diffs against.
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders nothing when every written row matches the live schedule (the silent case)', async () => {
    const lease = baseLease();
    stubFetch(lease.id, [
      charge({ id: '00000000-0000-7000-8000-00000000000a', generationKey: '2026-01-01', amountCents: 100000, dueDate: '2026-01-01' }),
      charge({ id: '00000000-0000-7000-8000-00000000000b', generationKey: '2026-02-01', amountCents: 100000, dueDate: '2026-02-01', periodStart: '2026-02-01', periodEnd: '2026-02-28' }),
    ]);

    renderBanner(lease);

    await waitFor(() => expect(screen.queryByText(/charges need review/i)).not.toBeInTheDocument());
  });

  it('reports amount drift, a missing period, and an unscheduled row together, each with its own action', async () => {
    const lease = baseLease();
    stubFetch(lease.id, [
      // January was billed at the OLD rent — a rent-step correction landed after
      // this row was already written.
      charge({ id: '00000000-0000-7000-8000-00000000000a', generationKey: '2026-01-01', amountCents: 90000, dueDate: '2026-01-01' }),
      // February has no row at all yet.
      // An extra row for a period the current schedule no longer wants.
      charge({ id: '00000000-0000-7000-8000-00000000000c', generationKey: '2025-12-01', amountCents: 100000, dueDate: '2025-12-01', periodStart: '2025-12-01', periodEnd: '2025-12-31' }),
    ]);

    const { onReviewCharge, onVoidCharge } = renderBanner(lease);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    expect(await screen.findByText(/charges need review/i)).toBeInTheDocument();
    // The sentence is split across a `<strong>{count}</strong>` and plain text —
    // RTL's default `getByText` only matches a single element's own text node, so
    // assert on the body's full text instead of a regex that spans both.
    expect(document.body.textContent).toMatch(/1 written charge was billed under terms/i);
    expect(document.body.textContent).toMatch(/1 scheduled period has no charge yet/i);
    expect(document.body.textContent).toMatch(/1 written charge no longer matches/i);

    await user.click(screen.getByRole('button', { name: /^review$/i }));
    expect(onReviewCharge).toHaveBeenCalledWith('00000000-0000-7000-8000-00000000000a');

    await user.click(screen.getByRole('button', { name: /^void it$/i }));
    expect(onVoidCharge).toHaveBeenCalledWith('00000000-0000-7000-8000-00000000000c');
  });

  it('a mismatched due date reports as `due_date` drift, not `amount`', async () => {
    const lease = baseLease();
    stubFetch(lease.id, [
      charge({ id: '00000000-0000-7000-8000-00000000000a', generationKey: '2026-01-01', amountCents: 100000, dueDate: '2026-01-05' }),
      charge({ id: '00000000-0000-7000-8000-00000000000b', generationKey: '2026-02-01', amountCents: 100000, dueDate: '2026-02-01', periodStart: '2026-02-01', periodEnd: '2026-02-28' }),
    ]);

    renderBanner(lease);

    expect(await screen.findByText(/charges need review/i)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/1 written charge was billed under terms/i);
    expect(screen.queryByText(/period has no charge yet/i)).not.toBeInTheDocument();
  });

  it('"Run generation" calls the generate endpoint and reports how many were created', async () => {
    const lease = baseLease();
    stubFetch(
      lease.id,
      [charge({ id: '00000000-0000-7000-8000-00000000000a', generationKey: '2026-01-01', amountCents: 100000, dueDate: '2026-01-01' })],
      () => [charge({ id: '00000000-0000-7000-8000-00000000000b', generationKey: '2026-02-01', amountCents: 100000, dueDate: '2026-02-01' })],
    );

    renderBanner(lease);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const generateButton = await screen.findByRole('button', { name: /run generation/i });
    await user.click(generateButton);

    await waitFor(() => expect(document.body.textContent).toMatch(/1 charge\(s\) generated/i));
  });

  it('never treats a manual charge as drift — it has no generation key to compare', async () => {
    const lease = baseLease();
    stubFetch(lease.id, [
      charge({ id: '00000000-0000-7000-8000-00000000000a', generationKey: '2026-01-01', amountCents: 100000, dueDate: '2026-01-01' }),
      charge({ id: '00000000-0000-7000-8000-00000000000b', generationKey: '2026-02-01', amountCents: 100000, dueDate: '2026-02-01', periodStart: '2026-02-01', periodEnd: '2026-02-28' }),
      charge({ id: '00000000-0000-7000-8000-00000000000d', generationKey: null, type: 'late_fee', source: 'manual', amountCents: 5000, dueDate: '2026-01-10' }),
    ]);

    renderBanner(lease);

    await waitFor(() => expect(screen.queryByText(/charges need review/i)).not.toBeInTheDocument());
  });
});
