import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { Property } from '@rms/contract';
import { PropertyFormDialog } from './PropertyFormDialog';

function renderDialog(property?: Property) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PropertyFormDialog open onOpenChange={() => {}} property={property} />
    </QueryClientProvider>,
  );
}

function makeProperty(overrides: Partial<Property> = {}): Property {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Baisakh House',
    type: 'single_family',
    address: {
      line1: '1 Main St',
      city: 'Kathmandu',
      region: 'Bagmati',
      postalCode: '44600',
      country: 'NP',
    },
    notes: null,
    timezone: 'Asia/Kathmandu',
    moveOutBillingPolicy: 'bill_full_term',
    calendar: 'gregorian',
    unitCount: 1,
    occupiedUnitCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
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

  it('defaults a new property to Gregorian and "bill the full term"', () => {
    renderDialog();

    expect(screen.getByRole('radio', { name: /^gregorian/i })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /bill the full term even if they leave early/i }),
    ).toBeChecked();
  });

  it('round-trips an existing property\'s calendar and move-out policy into the form', () => {
    const property = makeProperty({
      calendar: 'bikram_sambat',
      moveOutBillingPolicy: 'stop_at_move_out',
    });
    renderDialog(property);

    expect(screen.getByRole('radio', { name: /^bikram sambat/i })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /stop billing on the move-out date/i }),
    ).toBeChecked();
    // The other options are present but not selected.
    expect(screen.getByRole('radio', { name: /^gregorian/i })).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /bill the full term even if they leave early/i }),
    ).not.toBeChecked();
  });

  it('lets the calendar and move-out policy be changed and holds the new selection', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('radio', { name: /^bikram sambat/i }));
    await user.click(screen.getByRole('radio', { name: /stop billing on the move-out date/i }));

    expect(screen.getByRole('radio', { name: /^bikram sambat/i })).toBeChecked();
    expect(
      screen.getByRole('radio', { name: /stop billing on the move-out date/i }),
    ).toBeChecked();
    expect(screen.getByRole('radio', { name: /^gregorian/i })).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /bill the full term even if they leave early/i }),
    ).not.toBeChecked();
  });
});
