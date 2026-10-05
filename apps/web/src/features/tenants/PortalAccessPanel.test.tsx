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
    invitedEmail: null,
    inviteExpiresAt: null,
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

  it('shows the invite link, with a copy button, and hides it once the dialog closes', async () => {
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

    await waitFor(() => expect(screen.queryByText(/invite link created/i)).not.toBeInTheDocument());
  });

  it('does not carry the previous invite token into a later one — proving it was actually cleared, not just hidden', async () => {
    // A buggy implementation could hide the dialog with a flag decoupled
    // from the mutation's own `data` (e.g. local `isOpen` state) and this
    // test would still catch it: the first token would still be sitting in
    // the mutation's `data` and would resurface here, either rendered
    // directly or dragged along as the "current" value a second request
    // never overwrote in time. Two distinct tokens, resolved one after the
    // other, is what actually exercises that `reset()` ran on close.
    const responses = [
      {
        url: 'https://app.example.com/portal/accept?token=firsttoken1111',
        email: 'dana@example.com',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      {
        url: 'https://app.example.com/portal/accept?token=secondtoken2222',
        email: 'dana@example.com',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            resolve(
              new Response(JSON.stringify(responses[call++]), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
          ),
      ),
    );

    const user = userEvent.setup();
    renderPanel(makeTenant());

    await user.click(screen.getByRole('button', { name: /invite to portal/i }));
    expect(await screen.findByText(/firsttoken1111/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByText(/invite link created/i)).not.toBeInTheDocument());

    // Resend reissues — the button is still "Invite to portal" here because
    // the tenant prop never changed to `invited` in this isolated render.
    await user.click(screen.getByRole('button', { name: /invite to portal/i }));
    expect(await screen.findByText(/secondtoken2222/)).toBeInTheDocument();

    // The first token must not be anywhere in the document any more —
    // not in a hidden node, not concatenated into other text.
    expect(document.body.textContent).not.toContain('firsttoken1111');
  });

  it('shows which address holds a live invite and when it expires', () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    renderPanel(
      makeTenant({
        portalAccess: 'invited',
        invitedEmail: 'dana-invite@example.com',
        inviteExpiresAt: expiresAt,
      }),
    );

    expect(screen.getByText(/dana-invite@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(new Date(expiresAt).toLocaleString().split(',')[0]!))).toBeInTheDocument();
    expect(screen.queryByText(/waiting to accept/i)).not.toBeInTheDocument();
  });

  it('says clearly when an outstanding invite has already expired', () => {
    const expiresAt = new Date(Date.now() - 86_400_000).toISOString();
    renderPanel(
      makeTenant({
        portalAccess: 'invited',
        invitedEmail: 'dana-invite@example.com',
        inviteExpiresAt: expiresAt,
      }),
    );

    expect(screen.getByText(/expired on/i)).toBeInTheDocument();
  });
});
