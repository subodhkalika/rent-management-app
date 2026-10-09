import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LeaseDetail } from '@rms/contract';
import { ActivateLeaseDialog } from './ActivateLeaseDialog';

const now = '2026-01-01T00:00:00.000Z';

function draftLease(overrides: Partial<LeaseDetail> = {}): LeaseDetail {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    chainId: '00000000-0000-7000-8000-000000000002',
    status: 'draft',
    unitId: '00000000-0000-7000-8000-000000000003',
    unitLabel: 'Unit 1',
    propertyId: '00000000-0000-7000-8000-000000000004',
    propertyName: 'Maple St',
    propertyTimezone: 'UTC',
    calendar: 'gregorian',
    // Onboarding an in-flight tenancy: the lease began months ago.
    startDate: '2025-06-15',
    endDate: null,
    moveOutDate: null,
    rentCents: 100000,
    currency: 'USD',
    rentFrequency: 'monthly',
    billingDay: 1,
    depositCents: 50000,
    openingBalanceCents: 0,
    ledgerStartDate: '2026-03-01',
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
    unitStatus: 'vacant',
    propertyAddress: { line1: '1 Maple St', city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
    chain: [],
    rentSteps: [],
    ...overrides,
  };
}

function renderDialog(lease: LeaseDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActivateLeaseDialog open onOpenChange={vi.fn()} lease={lease} />
    </QueryClientProvider>,
  );
}

describe('ActivateLeaseDialog — the onboarding guard-rail (docs/PLAN-PHASE3A.md §8)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the count, total and overdue count before the landlord commits', () => {
    renderDialog(draftLease());

    // Charges are written on a period's first day, never earlier (§ the contract's
    // `GENERATION_LOOKAHEAD_DAYS`), so "today" (2026-03-31) only reaches the March
    // rent period — April's hasn't started yet. 1 rent period + 1 deposit = 2
    // charges; both are already due before today, so both are overdue.
    expect(document.body.textContent).toMatch(/activating creates\s*2\s*charges totalling/i);
    expect(document.body.textContent).toMatch(/\$1,500\.00/); // $1,000 rent + $500 deposit
    expect(document.body.textContent).toMatch(/2\s*are already overdue/i);
  });

  it('says plainly when nothing falls within the lookahead, rather than showing a count of zero', () => {
    renderDialog(draftLease({ startDate: '2030-01-01', ledgerStartDate: '2030-01-01', depositCents: 0 }));
    expect(screen.getByText(/writes no charges yet/i)).toBeInTheDocument();
  });
});
