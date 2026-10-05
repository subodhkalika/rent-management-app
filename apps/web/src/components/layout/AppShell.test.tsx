import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MeContext } from '@rms/contract';
import { AppShell } from './AppShell';

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
});
