import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingPage } from './OnboardingPage';

const create = vi.fn();
const setActive = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  organization: {
    create: (...args: unknown[]) => create(...args),
    setActive: (...args: unknown[]) => setActive(...args),
  },
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/properties" element={<div>Properties page</div>} />
      </Routes>
    </MemoryRouter>,
  );
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
});
