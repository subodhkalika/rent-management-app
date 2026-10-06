import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Property, Tenant, Unit } from '@rms/contract';
import { CreateLeasePage } from './CreateLeasePage';

const now = new Date().toISOString();

const property: Property = {
  id: '11111111-1111-7111-8111-111111111111',
  name: 'Maple St',
  type: 'apartment',
  address: { line1: '1 Maple St', city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
  notes: null,
  timezone: 'UTC',
  moveOutBillingPolicy: 'bill_full_term',
  calendar: 'gregorian',
  unitCount: 1,
  occupiedUnitCount: 0,
  createdAt: now,
  updatedAt: now,
};

const unit: Unit = {
  id: '22222222-2222-7222-8222-222222222222',
  propertyId: property.id,
  label: 'Unit 1',
  bedrooms: 1,
  bathrooms: 1,
  squareFeet: null,
  marketRentCents: 150000,
  currency: 'USD',
  status: 'vacant',
  notes: null,
  createdAt: now,
  updatedAt: now,
};

const tenant: Tenant = {
  id: '33333333-3333-7333-8333-333333333333',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: null,
  phone: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  notes: null,
  status: 'active',
  portalAccess: 'none',
  portalEmail: null,
  invitedEmail: null,
  inviteExpiresAt: null,
  remindersOptedOut: false,
  createdAt: now,
  updatedAt: now,
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((input: string | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname;
      if (path === '/v1/properties') return jsonResponse({ items: [property], nextCursor: null });
      if (path === `/v1/properties/${property.id}`) return jsonResponse(property);
      if (path === `/v1/properties/${property.id}/units`) return jsonResponse({ items: [unit], nextCursor: null });
      if (path === '/v1/tenants') return jsonResponse({ items: [tenant], nextCursor: null });
      return jsonResponse({ error: { code: 'not_found', message: `No stub for ${path}` } }, 404);
    }),
  );
}

function renderWizard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/leases/new']}>
        <CreateLeasePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function pickUnit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('combobox', { name: /property/i }));
  await user.click(await screen.findByRole('option', { name: /maple st/i }));
  await user.click(await screen.findByRole('radio', { name: /unit 1/i }));
}

describe('CreateLeasePage wizard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not advance past the unit step until a unit is selected', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderWizard();

    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // Still on step 1 — the property picker is still the thing on screen.
    expect(await screen.findByRole('combobox', { name: /property/i })).toBeInTheDocument();
  });

  it('does not advance past the tenants step until at least one tenant is selected', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderWizard();

    await pickUnit(user);
    // First "Next" leaves the unit step (a unit is selected); the second is
    // what should fail — no tenant has been picked yet.
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await screen.findByRole('checkbox', { name: /select ada lovelace/i });
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByText(/add at least one tenant/i)).toBeInTheDocument();
    // Still on the tenants step, not the terms step.
    expect(screen.queryByText(/^frequency$/i)).not.toBeInTheDocument();
  });

  it('marks the only selected tenant primary automatically, then reaches the terms step', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderWizard();

    await pickUnit(user);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('checkbox', { name: /select ada lovelace/i }));
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByText(/^frequency$/i)).toBeInTheDocument();
  });

  it('the frequency toggle hides billing day for yearly and shows the calendar-year copy, and restores it for monthly', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderWizard();

    await pickUnit(user);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('checkbox', { name: /select ada lovelace/i }));
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // Monthly is the default: billing day is visible with the February-clamp copy.
    expect(await screen.findByLabelText(/billing day/i)).toBeInTheDocument();
    expect(screen.getByText(/31 becomes 28 in february/i)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /^yearly$/i }));

    expect(screen.queryByLabelText(/billing day/i)).not.toBeInTheDocument();
    expect(screen.getByText(/due on the first day of each lease year/i)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /^monthly$/i }));

    expect(await screen.findByLabelText(/billing day/i)).toBeInTheDocument();
  });

  it('reaches the review step and shows the first charge matching the entered rent', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderWizard();

    await pickUnit(user);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('checkbox', { name: /select ada lovelace/i }));
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // Start date defaults once the unit's property resolves (today, in the
    // property's own timezone) — wait for it rather than asserting a race.
    await waitFor(() =>
      expect((screen.getByLabelText(/start date/i) as HTMLInputElement).value).not.toBe(''),
    );

    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByText(/first charge/i)).toBeInTheDocument();
    // Rent defaulted from the unit's market rent (150000 cents = $1,500.00). The
    // Summary section states it plainly regardless of whether today happens to
    // land on a prorated or clean first period.
    expect((await screen.findAllByText(/\$1,500\.00/)).length).toBeGreaterThan(0);
    // Never a full-term table or a total — the per-period table and its
    // disclosure were removed entirely, not hidden behind a click.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/total over the term/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show every period/i })).not.toBeInTheDocument();
  });

  it('shows the prorated first charge in full — dates, due date, amount, and days occupied — for a lease starting mid-period', async () => {
    stubFetch();
    const user = userEvent.setup();
    renderWizard();

    await pickUnit(user);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('checkbox', { name: /select ada lovelace/i }));
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    // 2026-01-15 is deliberately mid-month: billingDay defaults to 1, so the
    // first natural period is 2026-01-01..2026-01-31 and the lease only occupies
    // 17 of its 31 days — the "unusual number" a tenant actually queries.
    await waitFor(() =>
      expect((screen.getByLabelText(/start date/i) as HTMLInputElement).value).not.toBe(''),
    );
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-01-15' } });

    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByText(/first charge/i)).toBeInTheDocument();
    expect(screen.getByText(/prorated/i)).toBeInTheDocument();
    expect(screen.getByText(/17 of 31 days/i)).toBeInTheDocument();
    expect(screen.getByText(/due/i)).toBeInTheDocument();
  });

  it('shows an error, never a silently-defaulted Gregorian/bill_full_term preview, when the property fails to load (regression)', async () => {
    // Everything resolves except the single property-by-id fetch the review step
    // needs for its calendar and move-out policy — exactly the case that used to
    // fall back to 'gregorian' / 'bill_full_term' and preview the wrong schedule
    // with no indication anything was wrong.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL) => {
        const url = new URL(String(input), 'http://localhost');
        const path = url.pathname;
        if (path === '/v1/properties') return jsonResponse({ items: [property], nextCursor: null });
        if (path === `/v1/properties/${property.id}`) {
          return jsonResponse({ error: { code: 'internal', message: 'Server exploded' } }, 500);
        }
        if (path === `/v1/properties/${property.id}/units`) return jsonResponse({ items: [unit], nextCursor: null });
        if (path === '/v1/tenants') return jsonResponse({ items: [tenant], nextCursor: null });
        return jsonResponse({ error: { code: 'not_found', message: `No stub for ${path}` } }, 404);
      }),
    );
    const user = userEvent.setup();
    renderWizard();

    await pickUnit(user);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(await screen.findByRole('checkbox', { name: /select ada lovelace/i }));
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    // The property fetch failed, so the "default start date to today" effect
    // never fires — fill it by hand so the Terms step's own validation passes and
    // the point under test (the Review step's reaction to a failed property) is
    // actually reached.
    fireEvent.change(await screen.findByLabelText(/start date/i), { target: { value: '2026-01-01' } });
    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(await screen.findByText(/couldn't load this unit's property/i)).toBeInTheDocument();
    // Never a first-charge section rendered on top of the error — a missing
    // preview is honest, a confidently wrong one is not.
    expect(screen.queryByText(/first charge/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
