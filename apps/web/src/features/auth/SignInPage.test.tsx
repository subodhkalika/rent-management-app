import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SignInPage } from './SignInPage';

const signInEmail = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  signIn: { email: (...args: unknown[]) => signInEmail(...args) },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/signin']}>
      <SignInPage />
    </MemoryRouter>,
  );
}

describe('SignInPage', () => {
  it('shows a validation error for a malformed email and an empty password', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^email$/i), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/enter a valid email address/i)).toBeInTheDocument();
    expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it('shows the mapped error message, not the raw one, on a failed sign-in', async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/^email$/i), 'person@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText(/incorrect email or password/i)).toBeInTheDocument();
    // Never the raw Better Auth message.
    expect(screen.queryByText(/^invalid email or password$/i)).not.toBeInTheDocument();
  });
});
