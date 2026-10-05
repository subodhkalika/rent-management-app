import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Property } from '@rms/contract';
import { PropertiesListPage } from './PropertiesListPage';

function makeProperty(name: string): Property {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    type: 'single_family',
    address: {
      line1: '1 Main St',
      city: 'Springfield',
      region: 'IL',
      postalCode: '62701',
      country: 'US',
    },
    notes: null,
    timezone: 'America/Chicago',
    unitCount: 1,
    occupiedUnitCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

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

  it('loads the next page of properties when "Load more" is clicked', async () => {
    const first = makeProperty('First Street');
    const second = makeProperty('Second Street');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: string | URL) => {
        const url = new URL(String(input), 'http://localhost');
        const cursor = url.searchParams.get('cursor');
        const body = cursor
          ? { items: [second], nextCursor: null }
          : { items: [first], nextCursor: 'page-2' };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('First Street')).toBeInTheDocument();
    expect(screen.queryByText('Second Street')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByText('Second Street')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument(),
    );
  });
});
