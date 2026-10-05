import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResetPasswordPage } from './ResetPasswordPage';

const useSession = vi.fn();
const signOut = vi.fn();
const resetPassword = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  useSession: (...args: unknown[]) => useSession(...args),
  signOut: (...args: unknown[]) => signOut(...args),
  resetPassword: (...args: unknown[]) => resetPassword(...args),
}));

function renderPage(path = '/reset-password?token=abc123') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/signin" element={<div>Sign-in page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ResetPasswordPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // The bug this guards against: the route used to live behind `GuestOnly`,
  // so a signed-in user holding a valid, emailed token could never reach
  // this form at all.
  it('renders the reset form even for an already-signed-in visitor', () => {
    useSession.mockReturnValue({
      data: { user: { id: 'u1', name: 'Dana', email: 'dana@example.com' } },
      isPending: false,
    });
    renderPage();

    expect(screen.getByRole('button', { name: /save new password/i })).toBeInTheDocument();
  });

  it('signs out the active session before sending the user to sign in with the new password', async () => {
    useSession.mockReturnValue({
      data: { user: { id: 'u1', name: 'Dana', email: 'dana@example.com' } },
      isPending: false,
    });
    resetPassword.mockResolvedValue({ data: { status: true }, error: null });

    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/new password/i), 'brandnewpassword1');
    await user.type(screen.getByLabelText(/confirm password/i), 'brandnewpassword1');
    await user.click(screen.getByRole('button', { name: /save new password/i }));

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    expect(signOut).toHaveBeenCalled();
    expect(resetPassword).toHaveBeenCalledWith({ newPassword: 'brandnewpassword1', token: 'abc123' });
  });

  it('does not sign out when there was no active session', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    resetPassword.mockResolvedValue({ data: { status: true }, error: null });

    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/new password/i), 'brandnewpassword1');
    await user.type(screen.getByLabelText(/confirm password/i), 'brandnewpassword1');
    await user.click(screen.getByRole('button', { name: /save new password/i }));

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('shows the missing-token message and never calls the API when the link has no token', () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    renderPage('/reset-password');

    expect(screen.getByText(/missing its token/i)).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });
});
