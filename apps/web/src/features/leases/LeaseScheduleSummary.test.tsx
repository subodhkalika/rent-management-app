import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { buildSchedule, formatMoney, type LeaseBillingTerms } from '@rms/contract';
import { LeaseScheduleSummary } from './LeaseScheduleSummary';

const threeYearTerms: LeaseBillingTerms = {
  frequency: 'monthly',
  calendar: 'gregorian',
  rentCents: 500000,
  billingDay: 1,
  startDate: '2023-01-15',
  endDate: '2025-12-10',
  ledgerStartDate: '2023-01-15',
  moveOutDate: null,
  moveOutBillingPolicy: 'bill_full_term',
};

describe('LeaseScheduleSummary', () => {
  it('collapses a long lease to a few rows, shows the total, and expands to every period on demand', async () => {
    const periods = buildSchedule(threeYearTerms, '2025-12-10');
    const totalCents = periods.reduce((sum, p) => sum + p.amountCents, 0);
    const user = userEvent.setup();

    render(
      <LeaseScheduleSummary periods={periods} currency="USD" calendar="gregorian" rentFrequency="monthly" />,
    );

    expect(screen.getByText('First period')).toBeInTheDocument();
    expect(screen.getByText('Then')).toBeInTheDocument();
    expect(screen.getByText('Final period')).toBeInTheDocument();
    expect(screen.getByText('Total over the term')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(totalCents, 'USD'))).toBeInTheDocument();

    // The full table is not shown until the disclosure is opened.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: new RegExp(`show every period \\(${periods.length}\\)`, 'i') }));

    const table = await screen.findByRole('table');
    // header row + one row per period.
    expect(within(table).getAllByRole('row')).toHaveLength(periods.length + 1);
  });

  it('renders a single-period lease as one clean row, with no disclosure to expand', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      calendar: 'gregorian',
      rentCents: 100000,
      billingDay: 1,
      startDate: '2026-03-05',
      endDate: '2026-03-20',
      ledgerStartDate: '2026-03-05',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
    };
    const periods = buildSchedule(terms, '2026-12-01');
    expect(periods).toHaveLength(1);

    render(
      <LeaseScheduleSummary periods={periods} currency="USD" calendar="gregorian" rentFrequency="monthly" />,
    );

    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText(/prorated, 16 of 31 days/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show every period/i })).not.toBeInTheDocument();
  });

  it('a clean single-rate lease reads as one row, not a "Then" dangling with nothing before it', () => {
    const terms: LeaseBillingTerms = {
      frequency: 'monthly',
      calendar: 'gregorian',
      rentCents: 150000,
      billingDay: 1,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      ledgerStartDate: '2026-01-01',
      moveOutDate: null,
      moveOutBillingPolicy: 'bill_full_term',
    };
    const periods = buildSchedule(terms, '2026-12-01');

    render(
      <LeaseScheduleSummary periods={periods} currency="USD" calendar="gregorian" rentFrequency="monthly" />,
    );

    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.queryByText('Then')).not.toBeInTheDocument();
    // The collapsed run states the amount and cadence only — the period count and
    // date span are derivable from the lease term already on screen, and spelling
    // them out here is exactly the noise collapsing the run was meant to remove.
    expect(screen.getByText(`onwards ${formatMoney(periods[0]!.amountCents, 'USD')} monthly`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`${periods.length} periods`))).not.toBeInTheDocument();
    // Still reconcilable in full, just not by default.
    expect(screen.getByRole('button', { name: new RegExp(`show every period \\(${periods.length}\\)`, 'i') })).toBeInTheDocument();
  });

  it('shows the empty state when there are no periods', () => {
    render(
      <LeaseScheduleSummary
        periods={[]}
        currency="USD"
        calendar="gregorian"
        rentFrequency="monthly"
        emptyMessage="Fill in the start date and rent to see the schedule."
      />,
    );

    expect(screen.getByText('Fill in the start date and rent to see the schedule.')).toBeInTheDocument();
    expect(screen.queryByText('Total over the term')).not.toBeInTheDocument();
  });
});
