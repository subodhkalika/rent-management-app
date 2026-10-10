import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { UnitFormDialog } from './UnitFormDialog';

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UnitFormDialog open onOpenChange={() => {}} propertyId="11111111-1111-7111-8111-111111111111" />
    </QueryClientProvider>,
  );
}

/** docs/BUGS.md #6 — the type decides which fields even appear. */
describe('UnitFormDialog', () => {
  it('asks for bedrooms and bathrooms when the type defaults to flat', () => {
    renderDialog();

    expect(screen.getByLabelText(/bedrooms/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/bathrooms/i)).toBeInTheDocument();
  });

  it('a shutter asks for neither bedrooms nor bathrooms', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('combobox', { name: /^type$/i }));
    await user.click(await screen.findByRole('option', { name: /shutter/i }));

    expect(screen.queryByLabelText(/bedrooms/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/bathrooms/i)).not.toBeInTheDocument();
  });

  it('switching back to flat brings the room fields back', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('combobox', { name: /^type$/i }));
    await user.click(await screen.findByRole('option', { name: /shutter/i }));
    expect(screen.queryByLabelText(/bedrooms/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /^type$/i }));
    await user.click(await screen.findByRole('option', { name: /^flat/i }));
    expect(screen.getByLabelText(/bedrooms/i)).toBeInTheDocument();
  });

  it('offers NPR alongside the other currencies (docs/BUGS.md #3)', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('combobox', { name: /currency/i }));
    expect(await screen.findByRole('option', { name: 'NPR' })).toBeInTheDocument();
  });
});
