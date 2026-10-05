import { describe, it, expect, beforeAll } from 'vitest';
import bikramSambatLib from 'bikram-sambat';
import { adToBs, bsToAd } from '@sbmdkl/nepali-date-converter';
import { BS_MIN_YEAR, BS_MAX_YEAR, BS_EPOCH_AD, BS_MONTH_LENGTHS } from './bs-data.js';

/**
 * Independently re-verifies `bs-data.ts` against two third-party libraries, the same
 * two the table's header claims were used to generate/verify it. This is the test
 * that catches a future hand-edit of the table, or either library silently revising
 * its own data: both would show up here as a disagreement, not as a developer's
 * belief about what "should" be true.
 *
 * NOT trusted: the table header's own prose claim of "32,976 days from 1944-01-01 to
 * 2043-01-01" / "89 shared year-rows". This test computes its OWN ground truth for
 * which range to check — from `BS_EPOCH_AD` plus the table's own row sums — rather
 * than hard-coding the header's numbers. See the bottom of this file for why: they
 * don't match the table that is actually committed (reported upward, not corrected
 * here per the task's instruction not to hand-edit `bs-data.ts`).
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function addUtcDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe('bs-data.ts conformance', () => {
  // ground truth for the covered range, computed from the table itself — not asserted,
  // just used to drive the sweep below.
  const [epochYear, epochMonth, epochDay] = BS_EPOCH_AD.split('-').map(Number) as [number, number, number];
  const epochDate = new Date(Date.UTC(epochYear, epochMonth - 1, epochDay));

  it('BS_MONTH_LENGTHS has exactly one row per year in [BS_MIN_YEAR, BS_MAX_YEAR]', () => {
    expect(BS_MONTH_LENGTHS.length).toBe(BS_MAX_YEAR - BS_MIN_YEAR + 1);
    for (const row of BS_MONTH_LENGTHS) expect(row.length).toBe(12);
  });

  describe('year-sum self-check: a year row sums to the gap between consecutive Baisakh 1s', () => {
    // Baisakh-1 AD dates are fetched independently from the LIBRARY, not derived from
    // this table's own row sums — otherwise the check would be tautological.
    it.each(
      Array.from({ length: BS_MAX_YEAR - BS_MIN_YEAR }, (_, i) => BS_MIN_YEAR + i), // BS_MIN_YEAR .. BS_MAX_YEAR-1
    )('BS %i', (year) => {
      const thisStart = bsToAd(`${year}-01-01`);
      const nextStart = bsToAd(`${year + 1}-01-01`);
      const days = Math.round((Date.parse(nextStart) - Date.parse(thisStart)) / 86_400_000);
      const row = BS_MONTH_LENGTHS[year - BS_MIN_YEAR];
      expect(row).toBeDefined();
      const rowSum = (row ?? []).reduce((a, b) => a + b, 0);
      expect(rowSum).toBe(days);
    });
  });

  describe('bikram-sambat@^1 agrees on every month length', () => {
    it('daysInMonth matches for every (year, month) in range', () => {
      const mismatches: string[] = [];
      for (let year = BS_MIN_YEAR; year <= BS_MAX_YEAR; year += 1) {
        const row = BS_MONTH_LENGTHS[year - BS_MIN_YEAR] ?? [];
        for (let month = 1; month <= 12; month += 1) {
          const ours = row[month - 1];
          const theirs = bikramSambatLib.daysInMonth(year, month);
          if (ours !== theirs) mismatches.push(`BS ${year}-${pad2(month)}: ours=${ours} bikram-sambat=${theirs}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  });

  describe('full-range day-by-day cross-check against both libraries', () => {
    // Walks every (year, month, day) this table defines, in order, advancing a running
    // Gregorian date by exactly one day per step — the most direct possible reading of
    // "this table is a sequence of month lengths starting at BS_EPOCH_AD". Each day is
    // checked BOTH ways (BS -> AD and AD -> BS) against BOTH libraries.
    let totalDays = 0;
    let bikramSambatMismatches: string[] = [];
    let sbmdklMismatches: string[] = [];

    beforeAll(() => {
      let running = epochDate;
      for (let year = BS_MIN_YEAR; year <= BS_MAX_YEAR; year += 1) {
        const row = BS_MONTH_LENGTHS[year - BS_MIN_YEAR] ?? [];
        for (let month = 1; month <= 12; month += 1) {
          const len = row[month - 1] ?? 0;
          for (let day = 1; day <= len; day += 1) {
            totalDays += 1;
            const expectedIso = toIso(running);
            const bsIso = `${year}-${pad2(month)}-${pad2(day)}`;

            const bikramGreg = bikramSambatLib.toGreg_text(year, month, day);
            const bikramBik = bikramSambatLib.toBik_euro(expectedIso);
            if (bikramGreg !== expectedIso || bikramBik !== bsIso) {
              bikramSambatMismatches.push(
                `BS ${bsIso} <-> AD ${expectedIso}: bikram-sambat toGreg=${bikramGreg} toBik=${bikramBik}`,
              );
            }

            const sbmdklGreg = bsToAd(bsIso);
            const sbmdklBik = adToBs(expectedIso);
            if (sbmdklGreg !== expectedIso || sbmdklBik !== bsIso) {
              sbmdklMismatches.push(
                `BS ${bsIso} <-> AD ${expectedIso}: @sbmdkl bsToAd=${sbmdklGreg} adToBs=${String(sbmdklBik)}`,
              );
            }

            running = addUtcDays(running, 1);
          }
        }
      }
    });

    it('covers a plausible number of days (sanity bound, not a magic constant)', () => {
      // Deliberately a bound, not an exact pinned number — see the note at the bottom
      // of this file about the header's unverified "32,976" figure.
      expect(totalDays).toBeGreaterThan(30_000);
      expect(totalDays).toBeLessThan(40_000);
    });

    it('agrees with bikram-sambat@^1 on every day in both directions', () => {
      expect(bikramSambatMismatches.slice(0, 20)).toEqual([]);
      expect(bikramSambatMismatches.length).toBe(0);
    });

    it('agrees with @sbmdkl/nepali-date-converter@^2 on every day in both directions', () => {
      expect(sbmdklMismatches.slice(0, 20)).toEqual([]);
      expect(sbmdklMismatches.length).toBe(0);
    });
  });
});

/**
 * FINDING, reported rather than fixed per the task's instruction not to hand-edit
 * `bs-data.ts`:
 *
 * The table's header comment claims the two libraries "agree on every one of 32,976
 * days from 1944-01-01 to 2043-01-01" and "all 89 shared year-rows of this table".
 * Neither figure matches the table that is actually committed:
 *
 * - `BS_MONTH_LENGTHS` has 91 rows (`BS_MIN_YEAR` 2000 through `BS_MAX_YEAR` 2090
 *   inclusive), not 89.
 * - Summing every entry in every row gives 33,238 days, not 32,976.
 * - `BS_EPOCH_AD` is 1943-04-14 (BS 2000-01-01), and 1943-04-14 + 33,238 days lands on
 *   2034-04-14 (the start of the unsupported BS 2091-01-01) — so the table's actual
 *   covered span is AD 1943-04-14 through AD 2034-04-13, not "1944-01-01 to
 *   2043-01-01". The claimed end date is about nine years past where the data
 *   actually stops; `bikram-sambat@^1` itself throws ("No data for year: 2091 BS")
 *   for anything past BS 2090, confirming 2034-04-13 is the true boundary, not 2043.
 *
 * The data itself is NOT in question — every day this test checks (the table's real
 * span, independently computed above, not the header's claimed one) agrees with both
 * libraries with zero mismatches. Only the header's prose about WHICH range and HOW
 * MANY rows were verified is inconsistent with what is actually in the file.
 */
