import { describe, expect, it } from 'vitest';
import type { IsoDate } from '@rms/contract';
import { formatCivilDate } from './format-civil-date';

describe('formatCivilDate', () => {
  it('renders a Gregorian property in the plain local format, no cross-reference', () => {
    const rendering = formatCivilDate('2026-10-05' as IsoDate, 'gregorian');

    expect(rendering).not.toContain('(');
    // Locale-sensitive, so assert on the pieces rather than one exact string.
    expect(rendering).toMatch(/2026/);
    expect(rendering).toMatch(/5/);
    expect(rendering).toMatch(/Oct/i);
  });

  it('renders a Bikram Sambat property in both calendars — a known date, cross-checked', () => {
    // Verified by the orchestrator against the contract's own BS table:
    // 2026-10-05 decomposes to BS 2083-06-19, and monthNames[5] === 'Ashwin'.
    const rendering = formatCivilDate('2026-10-05' as IsoDate, 'bikram_sambat');

    expect(rendering).toContain('19 Ashwin 2083');
    // The Gregorian side is kept for cross-reference against bank statements etc.
    expect(rendering).toMatch(/\(.*2026.*\)/);
    expect(rendering).toMatch(/Oct/i);
  });

  it('renders the Nepali new year correctly — BS month/year roll over on the same day', () => {
    // Verified by the orchestrator: 2024-04-13 decomposes to BS 2081-01-01.
    const rendering = formatCivilDate('2024-04-13' as IsoDate, 'bikram_sambat');

    expect(rendering).toContain('1 Baisakh 2081');
  });

  it('falls back to the Gregorian rendering, not a crash, when the date is outside the BS table', () => {
    // BS covers roughly AD 1943–2034; a lease end date can genuinely predate that.
    const outOfRange = '1900-01-01' as IsoDate;

    const bsRendering = formatCivilDate(outOfRange, 'bikram_sambat');
    const gregorianRendering = formatCivilDate(outOfRange, 'gregorian');

    expect(bsRendering).toBe(gregorianRendering);
    expect(bsRendering).not.toContain('(');
  });

  it('refuses to convert an instant, even for a Bikram Sambat property', () => {
    // createdAt / an invite's expiresAt are instants, not civil dates — see
    // docs/DATES.md. This is the guard that stops someone from "helpfully" running
    // one through the calendar formatter: it must fail loudly, not quietly render a
    // Bikram Sambat date for something nobody agreed to in that calendar.
    const createdAt = '2026-10-05T08:00:00.000Z';

    expect(() => formatCivilDate(createdAt as IsoDate, 'bikram_sambat')).toThrow(/instant/i);
    expect(() => formatCivilDate(createdAt as IsoDate, 'gregorian')).toThrow(/instant/i);
  });
});
