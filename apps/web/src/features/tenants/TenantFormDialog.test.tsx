import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@rms/contract';
import { TenantFormDialog } from './TenantFormDialog';

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TenantFormDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

/**
 * Regression for docs/BUGS.md #4 — "Enter a valid email address" fired on a left-
 * empty optional field. `email.optional()` only ever accepted `undefined`; a text
 * input that was focused and left blank submits `''`. The contract now routes every
 * optional text field through `optionalText` (accepts `''` as absent), and submits
 * route them through `blankToUndefined` — this proves the whole chain for every
 * optional field on this form, not only the one that was reported.
 */
describe('TenantFormDialog — optional fields left blank', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits with every optional field left empty, with no client-side validation error', async () => {
    let sentBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === routes.tenants.create() && init?.method === 'POST') {
          sentBody = init.body ? JSON.parse(init.body as string) : undefined;
          return jsonResponse(
            {
              id: '11111111-1111-7111-8111-111111111111',
              firstName: 'Ada',
              lastName: 'Lovelace',
              email: null,
              phone: null,
              emergencyContactName: null,
              emergencyContactPhone: null,
              notes: null,
              status: 'prospect',
              portalAccess: 'none',
              portalEmail: null,
              invitedEmail: null,
              inviteExpiresAt: null,
              remindersOptedOut: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            201,
          );
        }
        return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/first name/i), 'Ada');
    await user.type(screen.getByLabelText(/last name/i), 'Lovelace');
    // Email, phone, emergency contact name/phone and notes are all left blank.

    // Focus and blur the email field — the exact sequence that used to submit ''
    // and trip ".email()" before the field's own value was ever read.
    await user.click(screen.getByLabelText(/email/i));
    await user.click(screen.getByLabelText(/^phone/i));

    await user.click(screen.getByRole('button', { name: /add tenant/i }));

    await waitFor(() => expect(sentBody).toBeDefined());

    expect(screen.queryByText(/enter a valid email address/i)).not.toBeInTheDocument();
    const body = sentBody as Record<string, unknown>;
    expect(body.email).toBeUndefined();
    expect(body.phone).toBeUndefined();
    expect(body.emergencyContactName).toBeUndefined();
    expect(body.emergencyContactPhone).toBeUndefined();
    expect(body.notes).toBeUndefined();
  });
});
