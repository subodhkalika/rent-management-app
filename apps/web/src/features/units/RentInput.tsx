import { forwardRef, useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { formatCentsAsRentInput, parseRentToCents } from './money';

interface RentInputProps {
  id?: string;
  /** Committed value, in integer cents. */
  value: number;
  /** Fires on blur with the parsed cents, or `NaN` if the text could not be parsed
   *  as a valid amount — letting the `money` schema's own message surface the error. */
  onChange: (cents: number) => void;
  onBlur?: () => void;
  name?: string;
  disabled?: boolean;
  'aria-invalid'?: boolean;
}

/**
 * A currency input that displays and edits dollars ("1,850.00") while the form value
 * underneath stays integer cents. Commits on blur so a half-typed amount never
 * flickers through as a parsed value.
 */
export const RentInput = forwardRef<HTMLInputElement, RentInputProps>(function RentInput(
  { value, onChange, onBlur, ...props },
  ref,
) {
  const [text, setText] = useState(() => formatCentsAsRentInput(value));

  // Re-sync from outside changes (form reset, loading the edit dialog) but never
  // fight the user mid-edit: only when they are not currently typing in the field.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(formatCentsAsRentInput(value));
  }, [value, focused]);

  return (
    <Input
      {...props}
      ref={ref}
      inputMode="decimal"
      placeholder="0.00"
      value={text}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        const cents = parseRentToCents(text);
        onChange(cents ?? NaN);
        if (cents !== null) setText(formatCentsAsRentInput(cents));
        onBlur?.();
      }}
    />
  );
});
