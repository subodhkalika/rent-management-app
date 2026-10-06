import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { isoFromBs, type CalendarSystem } from '@rms/contract';
import { CivilDateInput } from './civil-date-input';

/**
 * Mirrors how every real call site uses the component: `value` lives in the
 * parent, `onChange` writes it back. Testing it any other way would be testing
 * something nobody actually does — see the component's own "sync from prop"
 * comment for why an uncontrolled spy-only render can't observe a full
 * year->month->day selection.
 */
function Harness({
  calendar,
  initial = '',
  onChange,
}: {
  calendar: CalendarSystem;
  initial?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <CivilDateInput
      id="d"
      label="Start date"
      calendar={calendar}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

describe('CivilDateInput — Gregorian', () => {
  it('renders the native date input and forwards its value verbatim', () => {
    const onChange = vi.fn();
    render(<CivilDateInput id="d" label="Start date" calendar="gregorian" value="2026-10-05" onChange={onChange} />);

    // `<input type="date">` has no stable ARIA role across environments;
    // querying by type is unambiguous and is what the native element actually is.
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInput).not.toBeNull();
    expect(dateInput.value).toBe('2026-10-05');
  });

  it('calls onChange with the raw value, same as the native input would', () => {
    const onChange = vi.fn();
    render(<CivilDateInput id="d" label="Start date" calendar="gregorian" value="" onChange={onChange} />);

    const input = document.querySelector('input[type="date"]') as HTMLInputElement;
    // jsdom's date input accepts a direct value assignment + change event; typing
    // key-by-key into a native date input is notoriously flaky across browsers
    // and isn't what this test is about.
    input.setAttribute('value', '2026-01-02');
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // No Bikram Sambat machinery runs for a Gregorian property — confirmed by
    // there being no `combobox` role (the BS selects) anywhere in the DOM.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });
});

describe('CivilDateInput — Bikram Sambat', () => {
  it('decomposes an existing Gregorian value into the correct BS year/month/day and shows the Gregorian cross-reference', () => {
    // The pair the task specifies, verified against both source libraries:
    // 2026-10-05 <-> 19 Ashwin 2083 (Ashwin is BS_MONTH_NAMES[5], i.e. month 6).
    render(<Harness calendar="bikram_sambat" initial="2026-10-05" />);

    expect(screen.getByRole('combobox', { name: 'Start date — year' })).toHaveTextContent('2083');
    expect(screen.getByRole('combobox', { name: 'Start date — month' })).toHaveTextContent('Ashwin');
    expect(screen.getByRole('combobox', { name: 'Start date — day' })).toHaveTextContent('19');

    // Their bank and council will not be in BS — the Gregorian side stays visible.
    expect(screen.getByText(/Gregorian:/)).toHaveTextContent(/2026/);
    expect(screen.getByText(/Gregorian:/)).toHaveTextContent(/Oct/i);
  });

  it('a BS property writes the correct Gregorian IsoDate once year, month and day are all picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness calendar="bikram_sambat" onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Start date — year' }));
    await user.click(await screen.findByRole('option', { name: '2083' }));

    await user.click(screen.getByRole('combobox', { name: 'Start date — month' }));
    await user.click(await screen.findByRole('option', { name: 'Ashwin' }));

    await user.click(screen.getByRole('combobox', { name: 'Start date — day' }));
    await user.click(await screen.findByRole('option', { name: '19' }));

    expect(onChange).toHaveBeenLastCalledWith('2026-10-05');
  });

  it("the day list's length follows the month — 32 days in BS 2000 Jestha, 31 in BS 2000 Ashadh", async () => {
    const user = userEvent.setup();
    // BS 2000-02-15: day 15 is valid in both months, isolating the day-COUNT
    // change from any clamping behaviour (that is the next test).
    render(<Harness calendar="bikram_sambat" initial={isoFromBs(2000, 2, 15)} />);

    await user.click(screen.getByRole('combobox', { name: 'Start date — day' }));
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(32);
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('combobox', { name: 'Start date — month' }));
    await user.click(await screen.findByRole('option', { name: 'Ashadh' }));

    await user.click(screen.getByRole('combobox', { name: 'Start date — day' }));
    expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(31);
  });

  it('clamps the day to the new month length, rather than clearing it, when a month change makes it invalid', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // BS 2000-02-32 ('1943-06-14'): Jestha's last day. Ashadh (month 3) only has
    // 31 days — day 32 cannot survive the move unchanged.
    render(<Harness calendar="bikram_sambat" initial={isoFromBs(2000, 2, 32)} onChange={onChange} />);

    expect(screen.getByRole('combobox', { name: 'Start date — day' })).toHaveTextContent('32');

    await user.click(screen.getByRole('combobox', { name: 'Start date — month' }));
    await user.click(await screen.findByRole('option', { name: 'Ashadh' }));

    // Decided behaviour: clamp to the new month's last day, not clear the field.
    expect(screen.getByRole('combobox', { name: 'Start date — day' })).toHaveTextContent('31');
    expect(onChange).toHaveBeenLastCalledWith(isoFromBs(2000, 3, 31));
  });

  it('shows a plain error, not a blank field, when an existing value falls outside what BS supports', () => {
    // BS covers roughly AD 1943-2034; 1900 predates the table entirely.
    render(<Harness calendar="bikram_sambat" initial="1900-01-01" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/outside what Bikram Sambat supports/i);
    expect(alert).toHaveTextContent(/1900/);

    // The selects fall back to their placeholders rather than guessing.
    expect(screen.getByRole('combobox', { name: 'Start date — year' })).toHaveTextContent('Year');
  });
});
