import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { PropertyFormDialog } from './PropertyFormDialog';

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PropertyFormDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe('PropertyFormDialog', () => {
  it('shows a validation error when the name is left empty', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Leave "Name" empty and try to submit.
    await user.click(screen.getByRole('button', { name: /add property/i }));

    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
  });

  it('does not show a validation error once a name is entered', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/^name$/i), '123 Main St');
    await user.click(screen.getByRole('button', { name: /add property/i }));

    expect(screen.queryByText(/name is required/i)).not.toBeInTheDocument();
  });

  it('defaults the timezone field to the browser\'s own zone, not UTC', () => {
    renderDialog();

    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByRole('combobox', { name: /timezone/i })).toHaveTextContent(
      browserZone.replace(/_/g, ' '),
    );
  });

  it('lets the timezone be changed via the searchable combobox', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('combobox', { name: /timezone/i }));
    await user.type(screen.getByPlaceholderText(/search timezones/i), 'Perth');
    await user.click(await screen.findByRole('option', { name: 'Australia/Perth' }));

    expect(screen.getByRole('combobox', { name: /timezone/i })).toHaveTextContent(
      'Australia/Perth',
    );
  });
});
