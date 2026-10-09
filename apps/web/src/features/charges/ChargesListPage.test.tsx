import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { routes } from '@rms/contract';
import { ChargesListPage } from './ChargesListPage';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChargesListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Regresses the bug fixed in contract commit 835b80e: `overdueOnly` used
 * `z.coerce.boolean()`, which is `Boolean(value)`, so the string `"false"` a
 * browser actually sends parsed as `true` — the toggle could not be switched off,
 * and `hasAnySet` (correctly) treating `overdueOnly: false` as "nothing set" hid
 * the only way back short of a reload. The server-side fix is not this app's to
 * test; what IS this app's job is proving the CLIENT always sends the honest
 * string either way, so a re-regression on the server is visible immediately
 * rather than masked by a client that silently omits the flag when it's off.
 */
describe('ChargesListPage — the overdue-only toggle can be switched off', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends overdueOnly=true when switched on, then the literal overdueOnly=false when switched off again — and the toggle stays the only state driving it', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === routes.properties.list()) return jsonResponse({ items: [], nextCursor: null });
      if (url.pathname === routes.charges.list()) return jsonResponse({ items: [], nextCursor: null });
      return jsonResponse({ error: { code: 'not_found', message: 'no stub' } }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('switch', { name: /overdue only/i });
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)![0] as string;
      const url = new URL(lastCall, 'http://localhost');
      expect(url.searchParams.get('overdueOnly')).toBe('true');
    });
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => {
      const lastCall = fetchMock.mock.calls.at(-1)![0] as string;
      const url = new URL(lastCall, 'http://localhost');
      // The literal string "false" — never omitted, never coerced client-side.
      expect(url.searchParams.get('overdueOnly')).toBe('false');
    });
    // Back to the default state: nothing left to clear.
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument();
  });
});
