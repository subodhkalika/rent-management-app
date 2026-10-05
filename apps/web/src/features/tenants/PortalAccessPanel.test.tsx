import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tenant } from '@rms/contract';
import { PortalAccessPanel } from './PortalAccessPanel';

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  const now = new Date().toISOString();
  return {
    id: 't1',
    firstName: 'Dana',
    lastName: 'Scully',
    email: 'dana@example.com',
    phone: null,
    emergencyContactName: null,
    emergencyContactPhone: null,
    notes: null,
    status: 'active',
    portalAccess: 'none',
    portalEmail: null,
    remindersOptedOut: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function renderPanel(tenant: Tenant) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PortalAccessPanel tenant={tenant} />
    </QueryClientProvider>,
  );
}

describe('PortalAccessPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables "Invite to portal" when the tenant has no email on file', () => {
    renderPanel(makeTenant({ email: null }));

    expect(screen.getByRole('button', { name: /invite to portal/i })).toBeDisabled();
    expect(screen.getByText(/add an email address/i)).toBeInTheDocument();
  });

  it('shows the invite link exactly once, with a copy button, and clears it once the dialog closes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            url: 'https://app.example.com/portal/accept?token=abc123def456',
            email: 'dana@example.com',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const user = userEvent.setup();
    renderPanel(makeTenant());

    await user.click(screen.getByRole('button', { name: /invite to portal/i }));

    expect(await screen.findByText(/invite link created/i)).toBeInTheDocument();
    expect(screen.getByText(/abc123def456/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^done$/i }));

    // Closing the dialog must clear the one-time link from memory, not just
    // visually hide it — see PortalAccessPanel's `onClose` -> `mutation.reset()`.
    await waitFor(() => expect(screen.queryByText(/invite link created/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/abc123def456/)).not.toBeInTheDocument();
  });
});
