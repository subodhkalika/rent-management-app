import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSourceFiles, readSource } from '../test/support/repoGuard.js';

/**
 * Static guard for docs/DATES.md's central rule: NO date arithmetic anywhere in
 * `apps/api`. If this app needs to know what a period is, when a charge is due, or
 * how long a month is, it calls into `@rms/contract`'s `billing.ts` / `calendar/*` —
 * never recomputes it locally. The whole point of concentrating that logic in one
 * package is that a future calendar (Bikram Sambat is the named candidate) only ever
 * has to change there. This guard is what keeps the next person in a hurry from
 * quietly undoing that by inlining "just this one" date calculation in a route or a
 * repo function.
 *
 * Three violation shapes, each with its own detector below:
 *
 * 1. A LOCAL `daysInMonth` or `isLeapYear` — both already live in
 *    `@rms/contract` (re-exported from `billing.ts`, delegating to
 *    `./calendar/gregorian.js`). Importing and calling them is fine; DEFINING a
 *    same-named function or const here is the violation — it is either a duplicate
 *    (drifts the moment one of the two is edited) or a Gregorian-only shortcut that
 *    silently breaks a Bikram Sambat property.
 *
 * 2. `/ 30` or `/ 365` — the textbook "approximate a month/year as a fixed number of
 *    days" shortcut. Gregorian months vary 28–31 days with no closed form, and
 *    Bikram Sambat months vary 29–32 and change year to year (docs/DATES.md) — a
 *    literal divisor like this is never correct in either calendar, which is exactly
 *    why `billing.ts` does not contain one. (`periodIndexFor` in `billing.ts` DOES
 *    use `/ 30` and `/ 365`, but only as an initial ESTIMATE that a while-loop then
 *    corrects to exactness — and that file is not inside `apps/api`, so this guard
 *    never sees it.)
 *
 * 3. `new Date(...)` used to do calendar maths rather than to stamp an instant.
 *    Allowed: a bare `new Date()` (stamps "now" — `createdAt`, `updatedAt`,
 *    `deletedAt`, the `now` default param in `mappers.ts`) and `new Date(Date.now()
 *    + ms)` / `new Date(Date.now() - ms)` (a plain DURATION applied to "now", e.g.
 *    `tenants.ts`'s invite `expiresAt` — see docs/DATES.md's table: "a duration on an
 *    instant", not a calendar computation). Flagged: anything else passed to the
 *    constructor — most notably the legacy `new Date(year, month, day)` component
 *    form, which IS calendar arithmetic (it asks the JS runtime to resolve a
 *    year/month/day triple, Gregorian rules baked in) and has no Bikram Sambat
 *    analogue.
 *
 * Scans every non-test `.ts` file under `apps/api/src` via the same recursive,
 * comment/string-stripped source reading the tenancy guards use, so a violation
 * nested in a new subdirectory is caught the same way a missing `orgId` filter is.
 *
 * Two more rules, from Amendment A.2 of docs/PLAN-PHASE2.md (the move-out billing
 * policy): the policy is applied ONLY inside `buildSchedule`, so a caller that
 * pre-applies it — deriving an effective end date before calling `buildSchedule`,
 * or reasoning about `moveOutDate` directly — reintroduces the "two
 * implementations of the same date math" bug through the back door.
 *
 * 4. `effectiveBillingEnd` called anywhere in `apps/api/src`. It is exported from
 *    `@rms/contract` (so it is independently testable and so `buildSchedule` can
 *    call it internally) — NOT so a route or repo function can call it before
 *    `buildSchedule`. `billingTermsFor` is the only sanctioned way to build the
 *    terms object; nothing in this app ever needs to call `effectiveBillingEnd`
 *    directly.
 *
 * 5. `moveOutDate` passed as an argument to `minIsoDate`, `maxIsoDate` or
 *    `compareIsoDate`. Reading `moveOutDate` to render it is fine; REASONING about
 *    it — comparing it, clamping something to it — is `effectiveBillingEnd`'s job
 *    alone.
 *
 * Neither rule has a violation to catch today (confirmed before writing this) —
 * they exist so one introduced later fails loudly instead of shipping. The
 * apps/web half of this same amendment is frontend-dev's guard, in its own tree.
 */

const DIR = dirname(fileURLToPath(import.meta.url));

// Bump this UP whenever a legitimate source file is added. Never lower it to make a
// failing suite pass — see tenancy.guard.test.ts for why a floor exists at all.
const MIN_SOURCE_FILES = 33;

const FORBIDDEN_LOCAL_NAMES = ['daysInMonth', 'isLeapYear'];

function definesLocalHelper(src: string, name: string): boolean {
  const defPattern = new RegExp(
    `\\b(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|\\b(?:export\\s+)?(?:const|let)\\s+${name}\\s*(?::[^=]+)?=`,
  );
  return defPattern.test(src);
}

/** `x / 30` or `x / 365` — the fixed-days-per-month/year shortcut. Requires a `/`
 *  so it never fires on a bare "30" or "365" appearing for an unrelated reason. */
const MAGIC_DIVISOR = /\/\s*(?:30|365)\b(?!\d)/;

/**
 * Every `new Date(ARGS)` call in `src`, with `ARGS` as raw (stripped) text — found
 * by locating each `new Date(` and walking forward with paren-depth tracking, so a
 * nested call like `Date.now()` inside the argument list does not truncate the
 * capture at its own closing paren (a naive `[^)]*` regex would).
 */
function newDateArgLists(src: string): string[] {
  const out: string[] = [];
  const marker = /\bnew\s+Date\s*\(/g;
  for (let m = marker.exec(src); m; m = marker.exec(src)) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
    marker.lastIndex = i;
  }
  return out;
}

/** True if this `new Date(...)` call is one of the two allowed instant-stamping
 *  shapes: bare, or a plain duration (`Date.now() +/- ms`) applied to "now". */
function isAllowedNewDateCall(argsRaw: string): boolean {
  const args = argsRaw.trim();
  if (args === '') return true; // new Date() — stamps "now"
  return /^Date\.now\(\)\s*[+-]\s*[^,]+$/.test(args); // new Date(Date.now() +/- <duration>)
}

/**
 * Every `fnName(ARGS)` call in `src`, with `ARGS` as raw (stripped) text — same
 * paren-depth-walking technique as `newDateArgLists`, generalised to an arbitrary
 * function name, so a nested call inside the argument list doesn't truncate the
 * capture at its own closing paren.
 */
function callArgLists(src: string, fnName: string): string[] {
  const out: string[] = [];
  const marker = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
  for (let m = marker.exec(src); m; m = marker.exec(src)) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
    marker.lastIndex = i;
  }
  return out;
}

/** Amendment A.2, rule 4: `effectiveBillingEnd` is for `buildSchedule`'s internal
 *  use only — `apps/api` must never call it directly. */
function callsEffectiveBillingEnd(src: string): boolean {
  return callArgLists(src, 'effectiveBillingEnd').length > 0;
}

/** Amendment A.2, rule 5: `moveOutDate` must never be an argument to one of the
 *  three calendar-independent comparison helpers — reasoning about it belongs to
 *  `effectiveBillingEnd` alone, inside the contract. */
const DATE_COMPARISON_HELPERS = ['minIsoDate', 'maxIsoDate', 'compareIsoDate'];

function passesMoveOutDateToComparisonHelper(src: string): string | null {
  for (const fn of DATE_COMPARISON_HELPERS) {
    for (const args of callArgLists(src, fn)) {
      if (/\bmoveOutDate\b/.test(args)) return fn;
    }
  }
  return null;
}

describe('no-date-arithmetic guard (docs/DATES.md)', () => {
  const files = listSourceFiles(DIR);

  it('discovers at least the expected floor of source files', () => {
    expect(
      files.length,
      `Expected at least ${MIN_SOURCE_FILES} source files under apps/api/src, found ${files.length}. ` +
        'If this is a legitimate reduction, lower the floor explicitly and explain why in the same ' +
        'commit — otherwise file discovery broke and every check below is passing vacuously.',
    ).toBeGreaterThanOrEqual(MIN_SOURCE_FILES);
  });

  for (const file of files) {
    describe(file, () => {
      const src = readSource(DIR, file);

      for (const name of FORBIDDEN_LOCAL_NAMES) {
        it(`does not define a local ${name}`, () => {
          expect(
            definesLocalHelper(src, name),
            `${file} defines a local \`${name}\`. This already exists in @rms/contract ` +
              `(re-exported from billing.ts) — import it from there instead of recomputing it ` +
              'here. See docs/DATES.md.',
          ).toBe(false);
        });
      }

      it('contains no `/ 30` or `/ 365` fixed-days-per-period shortcut', () => {
        expect(
          MAGIC_DIVISOR.test(src),
          `${file} divides by a literal 30 or 365 — the "approximate a month/year as a fixed ` +
            'number of days" shortcut. Neither Gregorian nor Bikram Sambat months have a fixed ' +
            'length (docs/DATES.md); call into @rms/contract\'s billing.ts instead.',
        ).toBe(false);
      });

      it('uses `new Date(...)` only to stamp an instant, never to do calendar maths', () => {
        const calls = newDateArgLists(src);
        const offending = calls.filter((args) => !isAllowedNewDateCall(args));
        expect(
          offending,
          `${file} calls \`new Date(${offending[0] ?? ''})\` — only a bare \`new Date()\` (stamping ` +
            '"now") or `new Date(Date.now() +/- <duration>)` (a duration applied to "now") are ' +
            'allowed here. Anything else — especially the `new Date(year, month, day)` component ' +
            'form — is calendar arithmetic and belongs in @rms/contract, not apps/api. ' +
            'See docs/DATES.md.',
        ).toEqual([]);
      });

      it('never calls effectiveBillingEnd (Amendment A.2) — buildSchedule applies it internally', () => {
        expect(
          callsEffectiveBillingEnd(src),
          `${file} calls \`effectiveBillingEnd\` directly. It exists so BUILDSCHEDULE can apply the ` +
            'move-out policy internally — a caller pre-applying it is the "second implementation" ' +
            'bug the whole design exists to prevent. Build terms with `billingTermsFor` and pass ' +
            'them straight to `buildSchedule` instead.',
        ).toBe(false);
      });

      it('never passes moveOutDate to minIsoDate/maxIsoDate/compareIsoDate (Amendment A.2)', () => {
        const offendingFn = passesMoveOutDateToComparisonHelper(src);
        expect(
          offendingFn,
          `${file} passes \`moveOutDate\` to \`${offendingFn}\`. Reading moveOutDate to render it is ` +
            'fine; reasoning about it — comparing it, clamping to it — is effectiveBillingEnd\'s job ' +
            'alone, inside the contract.',
        ).toBeNull();
      });
    });
  }
});

describe('no-date-arithmetic guard — detectors proven against deliberate violations', () => {
  // Mirrors tenancy.guard.test.ts's "recursion proof": the detector logic above is
  // exercised here against throwaway fixture source, in both directions (flags the
  // bad shape, passes the good one), so this guard's failure mode has actually been
  // observed at least once rather than assumed.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'no-date-arithmetic-fixture-'));

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('flags a local daysInMonth definition', () => {
    const src = [
      'export function daysInMonth(year: number, month: number): number {',
      '  return 30;',
      '}',
      '',
    ].join('\n');
    expect(definesLocalHelper(src, 'daysInMonth')).toBe(true);
  });

  it('flags a local isLeapYear definition, including the const/arrow form', () => {
    const src = 'export const isLeapYear = (year: number): boolean => year % 4 === 0;\n';
    expect(definesLocalHelper(src, 'isLeapYear')).toBe(true);
  });

  it('does not flag merely importing or calling daysInMonth', () => {
    const src = [
      "import { daysInMonth } from '@rms/contract';",
      'const n = daysInMonth(2026, 4);',
      '',
    ].join('\n');
    expect(definesLocalHelper(src, 'daysInMonth')).toBe(false);
  });

  it('flags `/ 30` and `/ 365`', () => {
    expect(MAGIC_DIVISOR.test('const approxMonths = totalDays / 30;')).toBe(true);
    expect(MAGIC_DIVISOR.test('const approxYears = totalDays / 365;')).toBe(true);
  });

  it('does not flag an unrelated division or a bare 30/365', () => {
    expect(MAGIC_DIVISOR.test('const half = total / 2;')).toBe(false);
    expect(MAGIC_DIVISOR.test('const max = 365;')).toBe(false);
    // Guards against a divisor that merely starts with 30/365, e.g. "/ 3000".
    expect(MAGIC_DIVISOR.test('const x = total / 3000;')).toBe(false);
  });

  it('flags the legacy `new Date(year, month, day)` component form', () => {
    const calls = newDateArgLists('const d = new Date(2026, 3, 1);');
    expect(calls).toEqual(['2026, 3, 1']);
    expect(isAllowedNewDateCall(calls[0]!)).toBe(false);
  });

  it('flags `new Date(someDateString)`', () => {
    const calls = newDateArgLists('const d = new Date(someIsoString);');
    expect(isAllowedNewDateCall(calls[0]!)).toBe(false);
  });

  it('allows a bare `new Date()` used to stamp "now"', () => {
    const calls = newDateArgLists('const now = new Date();');
    expect(calls).toEqual(['']);
    expect(isAllowedNewDateCall(calls[0]!)).toBe(true);
  });

  it('allows `new Date(Date.now() + ms)`, a duration on an instant — not nested-paren-truncated', () => {
    const calls = newDateArgLists('const expiresAt = new Date(Date.now() + INVITE_TTL_MS);');
    expect(calls).toEqual(['Date.now() + INVITE_TTL_MS']);
    expect(isAllowedNewDateCall(calls[0]!)).toBe(true);
  });

  it('a deliberately bad fixture file, written to disk, is caught end to end', () => {
    const badFile = join(fixtureRoot, 'bad-date-math.ts');
    writeFileSync(
      badFile,
      [
        '// Deliberate violation under test — never commit anything that looks like this.',
        'export function daysInMonth(year: number, month: number): number {',
        '  const leap = year % 4 === 0;',
        '  return leap ? 29 : 28;',
        '}',
        'export function approxPeriods(totalDays: number): number {',
        '  return totalDays / 30;',
        '}',
        'export function legacyDate(year: number, month: number, day: number): Date {',
        '  return new Date(year, month - 1, day);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const src = readSource(fixtureRoot, 'bad-date-math.ts');
    expect(definesLocalHelper(src, 'daysInMonth')).toBe(true);
    expect(MAGIC_DIVISOR.test(src)).toBe(true);
    const calls = newDateArgLists(src);
    expect(calls.some((args) => !isAllowedNewDateCall(args))).toBe(true);
  });

  it('a well-formed fixture file passes every detector', () => {
    const goodFile = join(fixtureRoot, 'good-no-date-math.ts');
    writeFileSync(
      goodFile,
      [
        "import { daysInMonth, isLeapYear } from '@rms/contract';",
        'export function describeMonth(year: number, month: number): string {',
        '  return `${daysInMonth(year, month)} days, leap=${isLeapYear(year)}`;',
        '}',
        'export function stampNow(): Date {',
        '  return new Date();',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const src = readSource(fixtureRoot, 'good-no-date-math.ts');
    for (const name of FORBIDDEN_LOCAL_NAMES) {
      expect(definesLocalHelper(src, name)).toBe(false);
    }
    expect(MAGIC_DIVISOR.test(src)).toBe(false);
    const calls = newDateArgLists(src);
    expect(calls.every((args) => isAllowedNewDateCall(args))).toBe(true);
  });

  it('flags a direct call to effectiveBillingEnd', () => {
    const src = [
      "import { effectiveBillingEnd } from '@rms/contract';",
      'const end = effectiveBillingEnd(terms);',
      '',
    ].join('\n');
    expect(callsEffectiveBillingEnd(src)).toBe(true);
  });

  it('does not flag merely importing effectiveBillingEnd without calling it', () => {
    const src = "import type { LeaseBillingTerms } from '@rms/contract';\n";
    expect(callsEffectiveBillingEnd(src)).toBe(false);
  });

  it('does not flag buildSchedule or billingTermsFor, which are the sanctioned calls', () => {
    const src = [
      "import { buildSchedule, billingTermsFor } from '@rms/contract';",
      'const terms = billingTermsFor(lease);',
      'const periods = buildSchedule(terms, through);',
      '',
    ].join('\n');
    expect(callsEffectiveBillingEnd(src)).toBe(false);
  });

  it('flags moveOutDate passed to compareIsoDate, minIsoDate or maxIsoDate', () => {
    expect(passesMoveOutDateToComparisonHelper('compareIsoDate(lease.moveOutDate, today)')).toBe('compareIsoDate');
    expect(passesMoveOutDateToComparisonHelper('minIsoDate(a, moveOutDate, b)')).toBe('minIsoDate');
    expect(passesMoveOutDateToComparisonHelper('maxIsoDate(terms.moveOutDate)')).toBe('maxIsoDate');
  });

  it('does not flag moveOutDate passed to an unrelated function, or compareIsoDate called without it', () => {
    expect(passesMoveOutDateToComparisonHelper('render(lease.moveOutDate)')).toBeNull();
    expect(passesMoveOutDateToComparisonHelper('compareIsoDate(a.startDate, b.endDate)')).toBeNull();
  });

  it('a deliberate Amendment A.2 violation, written to disk, is caught end to end', () => {
    const badFile = join(fixtureRoot, 'bad-effective-billing-end.ts');
    writeFileSync(
      badFile,
      [
        "import { effectiveBillingEnd, compareIsoDate } from '@rms/contract';",
        'export function isPastMoveOut(terms, today) {',
        '  const end = effectiveBillingEnd(terms);',
        '  return compareIsoDate(terms.moveOutDate, today) < 0;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const src = readSource(fixtureRoot, 'bad-effective-billing-end.ts');
    expect(callsEffectiveBillingEnd(src)).toBe(true);
    expect(passesMoveOutDateToComparisonHelper(src)).toBe('compareIsoDate');
  });
});
