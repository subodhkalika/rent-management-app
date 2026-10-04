/**
 * Rent is edited in the UI as a decimal currency string ("1,850.00") and sent to the
 * API as integer cents (185000). Converting through a float (`Number(x) * 100`) risks
 * rounding error — e.g. 1850.00 * 100 can land on 184999.99999999997 in JS floats, and
 * `Math.round` only masks it for some inputs. We parse the string digit-by-digit
 * instead, so the conversion is exact for every value.
 */

/**
 * Parses a rent string into integer cents. Accepts thousands separators and an
 * optional 1- or 2-digit decimal part. Returns `null` if the string is not a valid,
 * non-negative amount.
 */
export function parseRentToCents(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const [wholePart, fractionPart = ''] = cleaned.split('.');
  const cents = fractionPart.padEnd(2, '0');

  const whole = Number(wholePart);
  const frac = Number(cents);
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(frac)) return null;

  return whole * 100 + frac;
}

/** Formats integer cents as a plain decimal string ("185000" -> "1850.00") for an
 *  editable input. Always 2 decimal places, no thousands separator — that's a
 *  display-only concern handled by `formatMoney` from the contract. */
export function formatCentsAsRentInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100)
    .toString()
    .padStart(2, '0');
  return `${whole}.${frac}`;
}
