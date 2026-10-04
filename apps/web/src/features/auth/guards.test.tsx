import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RequireAuth } from './guards';

const useSession = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  useSession: (...args: unknown[]) => useSession(...args),
}));

function renderProtected() {
  return render(
    <MemoryRouter initialEntries={['/properties']}>
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/properties" element={<div>Properties page</div>} />
        </Route>
        <Route path="/signin" element={<div>Sign-in page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  it('renders nothing that reveals the sign-in page while the session is still loading', () => {
    useSession.mockReturnValue({ data: null, isPending: true });
    renderProtected();

    expect(screen.queryByText('Sign-in page')).not.toBeInTheDocument();
    expect(screen.queryByText('Properties page')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated user to /signin', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    renderProtected();

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('renders the protected content for an authenticated user with an active organization', async () => {
    useSession.mockReturnValue({
      data: { session: { activeOrganizationId: 'org_1' }, user: { id: 'u1' } },
      isPending: false,
    });
    renderProtected();

    expect(await screen.findByText('Properties page')).toBeInTheDocument();
  });
});
