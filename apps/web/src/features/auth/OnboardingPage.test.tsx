import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnboardingPage } from './OnboardingPage';
import { meKeys } from '@/features/me/api';

const create = vi.fn();
const setActive = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  organization: {
    create: (...args: unknown[]) => create(...args),
    setActive: (...args: unknown[]) => setActive(...args),
  },
}));

function renderPage(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/onboarding']}>
        <Routes>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/properties" element={<div>Properties page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe('OnboardingPage', () => {
  it('calls organization.setActive with the new org id before navigating away', async () => {
    const callOrder: string[] = [];
    create.mockImplementation(async () => {
      callOrder.push('create');
      return { data: { id: 'org_123', name: 'Acme', slug: 'acme' }, error: null };
    });
    setActive.mockImplementation(async () => {
      callOrder.push('setActive');
      return { data: { id: 'org_123' }, error: null };
    });

    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/organization name/i), 'Acme');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    expect(await screen.findByText('Properties page')).toBeInTheDocument();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme', slug: 'acme' }),
    );
    expect(setActive).toHaveBeenCalledWith({ organizationId: 'org_123' });
    // The bug this guards against: landing on /properties without having called
    // setActive first, which 403s on the very next request.
    expect(callOrder).toEqual(['create', 'setActive']);
  });

  it('refetches the actor context BEFORE navigating, so the guard does not bounce back', async () => {
    // The bug, found by hand: create and setActive both succeeded server-side, but
    // /v1/me/context was still cached as `landlord: null` with a 60s staleTime. The
    // guard read that cache, sent the user straight back to /onboarding with a
    // cleared form — and retyping the same name then failed with "already exists",
    // because the organization genuinely had been created the first time.
    const order: string[] = [];
    create.mockImplementation(async () => {
      order.push('create');
      return { data: { id: 'org_123', name: 'Acme', slug: 'acme' }, error: null };
    });
    setActive.mockImplementation(async () => {
      order.push('setActive');
      return { data: { id: 'org_123' }, error: null };
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const refetchSpy = vi
      .spyOn(queryClient, 'refetchQueries')
      .mockImplementation(async () => { order.push('refetch'); });

    const user = userEvent.setup();
    renderPage(queryClient);

    await user.type(screen.getByLabelText(/organization name/i), 'Acme');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    expect(await screen.findByText('Properties page')).toBeInTheDocument();

    expect(refetchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: meKeys.context }),
    );
    // Order is the whole point: refetching after navigating fixes nothing.
    expect(order).toEqual(['create', 'setActive', 'refetch']);
  });

  it('does not navigate away if setActive fails, and shows an error instead', async () => {
    create.mockResolvedValue({ data: { id: 'org_123', name: 'Acme', slug: 'acme' }, error: null });
    setActive.mockResolvedValue({
      data: null,
      error: { code: 'ORGANIZATION_NOT_FOUND', message: 'Organization not found' },
    });

    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/organization name/i), 'Acme');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Properties page')).not.toBeInTheDocument();
  });

  it('derives the slug itself — the form never asks for one', () => {
    expect(screen.queryByLabelText(/url/i)).not.toBeInTheDocument();
  });

  it("retries with a suffix when a stranger's organization already holds the slug", async () => {
    // The slug is globally unique but invisible, so two unrelated landlords both
    // naming their organization "Mero Ghar" used to mean the second was told the
    // URL was taken — blocked by a name they cannot see and had no part in.
    const slugs: string[] = [];
    create.mockImplementation(async ({ slug }: { slug: string }) => {
      slugs.push(slug);
      return slugs.length === 1
        ? { data: null, error: { code: 'ORGANIZATION_SLUG_ALREADY_TAKEN' } }
        : { data: { id: 'org_2', name: 'Mero Ghar', slug }, error: null };
    });
    setActive.mockResolvedValue({ data: { id: 'org_2' }, error: null });

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/organization name/i), 'Mero Ghar');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    expect(await screen.findByText('Properties page')).toBeInTheDocument();
    expect(slugs[0]).toBe('mero-ghar');
    expect(slugs[1]).toMatch(/^mero-ghar-/);
  });

  it('creates an organization whose name is entirely non-Latin', async () => {
    // "मेरो घर" slugifies to nothing, which the old required URL field rejected.
    const slugs: string[] = [];
    create.mockImplementation(async ({ slug }: { slug: string }) => {
      slugs.push(slug);
      return { data: { id: 'org_3', name: 'मेरो घर', slug }, error: null };
    });
    setActive.mockResolvedValue({ data: { id: 'org_3' }, error: null });

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/organization name/i), 'मेरो घर');
    await user.click(screen.getByRole('button', { name: /create organization/i }));

    expect(await screen.findByText('Properties page')).toBeInTheDocument();
    expect(slugs[0]).toBe('org');
  });
});