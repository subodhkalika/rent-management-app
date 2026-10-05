import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ForgotPasswordPage } from './ForgotPasswordPage';

const useSession = vi.fn();
const signOut = vi.fn();
const requestPasswordReset = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  useSession: (...args: unknown[]) => useSession(...args),
  signOut: (...args: unknown[]) => signOut(...args),
  requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/forgot-password']}>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe('ForgotPasswordPage', () => {
  it('shows the reset form for a signed-out visitor', () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    renderPage();

    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  // The bug this guards against: a signed-in user who clicks the page was
  // silently redirected to /properties with no explanation, because the
  // route used to live behind `GuestOnly`.
  it('explains why, instead of silently redirecting, when the visitor is already signed in', () => {
    useSession.mockReturnValue({
      data: { user: { id: 'u1', name: 'Dana', email: 'dana@example.com' } },
      isPending: false,
    });
    renderPage();

    expect(screen.getByText(/already signed in/i)).toBeInTheDocument();
    expect(screen.getByText(/dana@example.com/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /sign out and continue/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send reset link/i })).not.toBeInTheDocument();
  });
});
