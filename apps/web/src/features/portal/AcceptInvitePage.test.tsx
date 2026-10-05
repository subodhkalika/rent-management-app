import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcceptInvitePage } from './AcceptInvitePage';

const useSession = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  useSession: (...args: unknown[]) => useSession(...args),
  signOut: vi.fn(),
}));

const TOKEN = 'a'.repeat(64);

function renderPage(path = `/portal/accept?token=${TOKEN}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AcceptInvitePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AcceptInvitePage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the generic invalid-invitation message, without calling the API, when the token is malformed', () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    renderPage('/portal/accept?token=not-a-real-token');

    expect(screen.getByText(/this invitation is no longer valid/i)).toBeInTheDocument();
  });

  it('renders the same generic failure message on a 404, regardless of the server-side reason', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'not_found', message: 'Invite revoked three days ago by landlord X' },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/your name/i), 'Dana Scully');
    await user.type(screen.getByLabelText(/^password$/i), 'supersecret123');
    await user.click(screen.getByRole('button', { name: /create account & accept invite/i }));

    expect(await screen.findByText(/this invitation is no longer valid/i)).toBeInTheDocument();
    // The uniform 404 copy is deliberate — the server's specific reason must
    // never reach the screen (docs/PLAN-V1.md §1.3, anti-enumeration).
    expect(screen.queryByText(/revoked three days ago/i)).not.toBeInTheDocument();
  });
});
