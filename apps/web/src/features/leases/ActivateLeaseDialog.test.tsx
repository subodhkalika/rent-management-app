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
    // today = 2026-03-31, the same derivation as `generationPlanFixtures` (31 days
    // before `through`) for fixture F9's own `through` of 2026-05-01.
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the count, total and overdue count before the landlord commits', () => {
    renderDialog(draftLease());

    // 3 rent periods (F9) + 1 deposit = 4 charges; deposit (2025-06-15) and the
    // first rent period (2026-03-01) are both before "today" (2026-03-31) — 2
    // already overdue.
    expect(document.body.textContent).toMatch(/activating creates\s*4\s*charges totalling/i);
    expect(document.body.textContent).toMatch(/\$3,500\.00/); // 3 x $1,000 rent + $500 deposit
    expect(document.body.textContent).toMatch(/2\s*are already overdue/i);
  });

  it('says plainly when nothing falls within the lookahead, rather than showing a count of zero', () => {
    renderDialog(draftLease({ startDate: '2030-01-01', ledgerStartDate: '2030-01-01', depositCents: 0 }));
    expect(screen.getByText(/writes no charges yet/i)).toBeInTheDocument();
  });
});
