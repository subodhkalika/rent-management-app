import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MeContext } from '@rms/contract';
import { AppShell } from './AppShell';
import { useSelectedTenancy } from '@/features/portal/tenancy-context';

/** Stands in for a real portal screen (like `PortalProfilePage`) that reads
 *  the selected tenancy. If `AppShell` ever renders `<Outlet/>` on a portal
 *  route without the provider in place, this throws during render — which
 *  is exactly the crash under test. */
function TenancyProbe() {
  const { selected } = useSelectedTenancy();
  return <div>Profile content for {selected.orgName}</div>;
}

const useSession = vi.fn();
const useMeContext = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  useSession: (...args: unknown[]) => useSession(...args),
  signOut: vi.fn(),
}));

vi.mock('@/features/me/api', () => ({
  useMeContext: (...args: unknown[]) => useMeContext(...args),
}));

const bothCtx: MeContext = {
  user: { id: 'u1', name: 'Dana', email: 'dana@example.com' },
  landlord: { orgId: 'org_1', orgName: 'Acme Lettings', role: 'owner' },
  tenancies: [{ orgId: 'org_2', orgName: 'Bob Rentals', tenantId: 't1' }],
};

function renderShell(initialPath: string) {
  useSession.mockReturnValue({ data: { user: { name: 'Dana', email: 'dana@example.com' } } });
  useMeContext.mockReturnValue({ data: bothCtx });

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/properties" element={<div>Properties content</div>} />
          <Route path="/portal" element={<div>Profile content</div>} />
          <Route path="/portal/profile" element={<div>Profile content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppShell', () => {
  it('shows an actor switch for a user who is both a landlord and a tenant, and it navigates', async () => {
    const user = userEvent.setup();
    renderShell('/properties');

    expect(screen.getByText('Properties content')).toBeInTheDocument();
    expect(screen.getByText('Acme Lettings')).toBeInTheDocument();

    const tenanciesLink = screen.getByRole('link', { name: /my tenancies/i });
    expect(tenanciesLink).toBeInTheDocument();

    await user.click(tenanciesLink);

    expect(await screen.findByText('Profile content')).toBeInTheDocument();
  });

  it('does not show an actor switch for a landlord with no tenancies', () => {
    useSession.mockReturnValue({ data: { user: { name: 'Dana', email: 'dana@example.com' } } });
    useMeContext.mockReturnValue({
      data: { ...bothCtx, tenancies: [] },
    });

    render(
      <MemoryRouter initialEntries={['/properties']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/properties" element={<div>Properties content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: /my tenancies/i })).not.toBeInTheDocument();
  });

  // Regression test for the review finding: AppShell used to seed the
  // selected tenancy from `ctx?.tenancies[0]` at mount and only correct it
  // in an effect, so a portal route could render `<Outlet/>` for one tick
  // without `PortalTenancyCtx` provided — crashing any screen that calls
  // `useSelectedTenancy()`, with no error boundary to catch it. It must now
  // be impossible to reach `<Outlet/>` on a portal route without the
  // provider in place, regardless of query cache timing.
  it('never renders a portal screen without a resolved tenancy to provide, even with zero tenancies', () => {
    useSession.mockReturnValue({ data: { user: { name: 'Dana', email: 'dana@example.com' } } });
    useMeContext.mockReturnValue({ data: { ...bothCtx, landlord: null, tenancies: [] } });

    expect(() =>
      render(
        <MemoryRouter initialEntries={['/portal']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/portal" element={<TenancyProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    ).not.toThrow();

    expect(screen.queryByText(/profile content for/i)).not.toBeInTheDocument();
    expect(screen.getByText(/don't have an active tenancy/i)).toBeInTheDocument();
  });

  it('shows a loading fallback, not a crash, on a portal route while /v1/me/context is still resolving', () => {
    useSession.mockReturnValue({ data: { user: { name: 'Dana', email: 'dana@example.com' } } });
    useMeContext.mockReturnValue({ data: undefined });

    expect(() =>
      render(
        <MemoryRouter initialEntries={['/portal']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/portal" element={<TenancyProbe />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    ).not.toThrow();

    expect(screen.queryByText(/profile content for/i)).not.toBeInTheDocument();
  });
});
