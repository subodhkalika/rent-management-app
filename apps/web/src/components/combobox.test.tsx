import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox } from './combobox';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

describe('Combobox', () => {
  it('shows the placeholder when there is no value', () => {
    render(<Combobox options={options} onChange={vi.fn()} placeholder="Pick one" />);

    expect(screen.getByRole('combobox')).toHaveTextContent('Pick one');
  });

  it('shows the matching option label when the value is in the options list', () => {
    render(<Combobox options={options} value="b" onChange={vi.fn()} />);

    expect(screen.getByRole('combobox')).toHaveTextContent('Beta');
  });

  it('renders a value that has no matching option as itself, not the placeholder', () => {
    // E.g. a stored zone the current options list doesn't enumerate — the field
    // holds a real value and must say so, not look empty.
    render(
      <Combobox
        options={options}
        value="Gamma"
        onChange={vi.fn()}
        placeholder="Pick one"
      />,
    );

    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('Gamma');
    expect(trigger).not.toHaveTextContent('Pick one');
  });

  it('matches an option by its extra search keywords, not just its label', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        options={[{ value: 'Asia/Calcutta', label: 'Asia/Calcutta', keywords: ['Kolkata'] }]}
        onChange={vi.fn()}
        searchPlaceholder="Search…"
      />,
    );

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search…'), 'Kolkata');

    expect(await screen.findByRole('option', { name: 'Asia/Calcutta' })).toBeInTheDocument();
  });
});
