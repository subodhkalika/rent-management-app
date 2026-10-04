import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PropertiesListPage } from './PropertiesListPage';

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PropertiesListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PropertiesListPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the empty state when the API returns no properties', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    renderPage();

    expect(await screen.findByText(/no properties yet/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /add property/i }).length).toBeGreaterThan(0);
  });

  it('renders the error state with a retry action when the API call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'internal', message: 'Server exploded' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    renderPage();

    expect(await screen.findByText(/couldn't load properties/i)).toBeInTheDocument();
    expect(screen.getByText(/server exploded/i)).toBeInTheDocument();
  });
});
