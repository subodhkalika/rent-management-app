/**
 * Ambient module declarations for the two conformance libraries used ONLY by
 * `bs-data.conformance.test.ts`. Neither ships usable types for how we consume it:
 * `bikram-sambat` ships no `.d.ts` at all, and `@sbmdkl/nepali-date-converter`'s types
 * exist but are not resolvable through its package.json `exports` map under
 * `moduleResolution: "bundler"`. These are typed narrowly, to exactly the surface the
 * conformance test calls — not a general-purpose declaration for either library.
 */

declare module 'bikram-sambat' {
  interface BikramSambat {
    daysInMonth(year: number, month: number): number;
    toBik(greg: string): { year: number; month: number; day: number };
    toBik_euro(greg: string): string;
    toBik_text(greg: string): string;
    toGreg(year: number, month: number, day: number): { year: number; month: number; day: number };
    toGreg_text(year: number, month: number, day: number): string;
  }
  const bikramSambat: BikramSambat;
  export default bikramSambat;
}

declare module '@sbmdkl/nepali-date-converter' {
  export function adToBs(adDate: string): string | { currentYear: number; currentMonth: number; currentDay: number };
  export function bsToAd(bsDate: string): string;
}
