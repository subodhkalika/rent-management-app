import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for docs/DATES.md's central rule, extended to `apps/web` by
 * Amendment A.2 (docs/PLAN-PHASE2.md): no date arithmetic outside
 * `packages/contract`. If this app needs to know what a period is, when a charge
 * is due, how long a month is, or what a lease's effective billing end is, it
 * calls into `@rms/contract` — never recomputes it locally. Two rules come
 * straight from the amendment's own wording:
 *
 *   - `effectiveBillingEnd` may not be called outside `packages/contract` — the
 *     move-out policy is applied INSIDE `buildSchedule`, never at a call site.
 *   - `moveOutDate` may not be passed to `minIsoDate` / `maxIsoDate` /
 *     `compareIsoDate` anywhere in `apps/web/src` — reading it to render it is
 *     fine, reasoning about it with these is not.
 *
 * Mirrors `apps/api/src/no-date-arithmetic.guard.test.ts` in spirit and in its
 * first two detectors (a local `daysInMonth`/`isLeapYear`, the `/ 30` or `/ 365`
 * fixed-days shortcut). File discovery and noise-stripping are reimplemented here
 * rather than imported across the app boundary — `apps/web` owns `apps/web/**`,
 * same as every other file in this tree; the backend's equivalent helper lives
 * under `apps/api/test/support`, outside this app entirely.
 *
 * The `new Date(...)` detector is ADAPTED, not copied, for a reason specific to
 * this app. `apps/web` legitimately parses INSTANT strings (`createdAt`,
 * `expiresAt`, an invite's liveness, ...) into a `Date` purely to call
 * `.toLocaleString()` / `.toLocaleDateString()` on it — that is category A in
 * docs/DATES.md (an instant, rendered in the viewer's own locale), not calendar
 * arithmetic, and it happens throughout this app already (`AcceptInvitePage.tsx`,
 * `PortalAccessPanel.tsx`). Apps/api's rule — "only a bare `new Date()` or
 * `new Date(Date.now() +/- duration)`" — would flag that legitimate, pre-existing
 * code on sight. The actual violation docs/DATES.md names is the multi-argument
 * CALENDAR-COMPONENT form, `new Date(year, month, day)`: asking the runtime to
 * resolve a y/m/d triple under hardcoded Gregorian rules, with no Bikram Sambat
 * analogue. A single-argument call — an instant string, a timestamp, another
 * `Date`, or `Date.UTC(...)`'s return value — is never that. So the rule here is
 * "no TOP-LEVEL comma in the argument list", which is exactly what lets
 * `format-civil-date.ts`'s `new Date(Date.UTC(year, month - 1, day))` pass: its
 * sole top-level argument is the whole `Date.UTC(...)` expression (the commas
 * inside belong to the NESTED call), and that function's job is presentation —
 * decomposing an already-validated civil date back into a `Date` only so
 * `Intl.DateTimeFormat` has something to format, never a computation.
 */

const DIR = dirname(fileURLToPath(import.meta.url));

// Bump this UP whenever a legitimate source file is added. Never lower it to make
// a failing suite pass — see apps/api's tenancy guards for why a floor exists.
//
// Lowered 103 -> 99 for a legitimate reduction: product feedback on the schedule
// preview removed the per-period table, its disclosure, and the "total over the
// term" row entirely (LeaseScheduleTable.tsx, LeaseScheduleSummary.tsx,
// schedule-summary.ts), and `nextDuePeriodIndex` (next-due.ts) went with them —
// it existed only to highlight a row in that table. The prorated-period preview
// these supported stays, now computed with a single-period `buildSchedule` call
// instead of building the whole term.
const MIN_SOURCE_FILES = 99;

const FORBIDDEN_LOCAL_NAMES = ['daysInMonth', 'isLeapYear'];

/** Every `.ts`/`.tsx` source file under `dir`, at any depth, excluding tests and
 *  declaration files. Paths are relative to `dir` with forward slashes. */
function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx') || entry.name.endsWith('.d.ts')) {
      continue;
    }

    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      dir;
    const full = join(parent, entry.name);
    out.push(relative(dir, full).split(sep).join('/'));
  }

  return out.sort();
}

/**
 * Strips comments and string/template literals so a mention inside either never
 * counts — a Tailwind class like `"bg-destructive/30"` must never trip the
 * `/ 30` divisor check below.
 *
 * The quote-matching here is DELIBERATELY restricted to a single line
 * (`[^'\\\n]`, `[^"\\\n]`), which apps/api's equivalent (pure `.ts`, no JSX) does
 * not need. A `.tsx` file's JSX text is full of apostrophes that are not string
 * delimiters at all — "wizard's", "doesn't", "that's" — and a naive
 * `'(?:[^'])*'` pair-matcher happily treats the FIRST stray apostrophe as opening
 * a string and consumes everything up to the NEXT one anywhere later in the
 * file, silently deleting real code in between and corrupting every check after
 * it. A real single-line string or template literal is unaffected by the
 * newline restriction (JS string literals cannot contain a literal newline
 * anyway); only the runaway cross-line pairing is what this blocks.
 */
function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

function readSource(dir: string, relativePath: string): string {
  return stripNoise(readFileSync(join(dir, ...relativePath.split('/')), 'utf8'));
}

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
 * nested call does not truncate the capture at its own closing paren.
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

/** True if `argsRaw` has no TOP-LEVEL comma — see the file header for why this,
 *  not "bare or `Date.now()` +/- duration" (apps/api's narrower rule), is the
 *  dividing line in this app. */
function hasTopLevelComma(argsRaw: string): boolean {
  let depth = 0;
  for (const ch of argsRaw) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return true;
  }
  return false;
}

function isAllowedNewDateCall(argsRaw: string): boolean {
  return !hasTopLevelComma(argsRaw.trim());
}

const EFFECTIVE_BILLING_END_CALL = /\beffectiveBillingEnd\s*\(/;

/** `moveOutDate` appearing as an argument inside a call to one of the three
 *  calendar-independent comparators. Reading `moveOutDate` to render it is fine;
 *  reasoning about it with these is not — that is `effectiveBillingEnd`'s job
 *  alone, and `effectiveBillingEnd` lives in `packages/contract` only. */
const MOVE_OUT_DATE_IN_COMPARATOR = /\b(?:minIsoDate|maxIsoDate|compareIsoDate)\s*\([^)]*\bmoveOutDate\b/i;

describe('no-date-arithmetic guard (docs/DATES.md, Amendment A.2)', () => {
  const files = listSourceFiles(DIR);

  it('discovers at least the expected floor of source files', () => {
    expect(
      files.length,
      `Expected at least ${MIN_SOURCE_FILES} source files under apps/web/src, found ${files.length}. ` +
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
            `${file} defines a local \`${name}\`. This already exists in @rms/contract — import it ` +
              'from there instead of recomputing it here. See docs/DATES.md.',
          ).toBe(false);
        });
      }

      it('contains no `/ 30` or `/ 365` fixed-days-per-period shortcut', () => {
        expect(
          MAGIC_DIVISOR.test(src),
          `${file} divides by a literal 30 or 365 — the "approximate a month/year as a fixed number ` +
            "of days\" shortcut. Neither Gregorian nor Bikram Sambat months have a fixed length " +
            "(docs/DATES.md); call into @rms/contract's billing.ts instead.",
        ).toBe(false);
      });

      it('uses `new Date(...)` only to stamp or parse an instant, never the multi-argument calendar-component form', () => {
        const calls = newDateArgLists(src);
        const offending = calls.filter((args) => !isAllowedNewDateCall(args));
        expect(
          offending,
          `${file} calls \`new Date(${offending[0] ?? ''})\` with more than one top-level argument — ` +
            'the legacy `new Date(year, month, day)` component form. That is calendar arithmetic and ' +
            'belongs in @rms/contract, not apps/web. See docs/DATES.md.',
        ).toEqual([]);
      });

      it('never calls effectiveBillingEnd directly (Amendment A.2)', () => {
        expect(
          EFFECTIVE_BILLING_END_CALL.test(src),
          `${file} calls \`effectiveBillingEnd\` directly. The move-out policy is applied INSIDE ` +
            'buildSchedule — build the terms via billingTermsFor (or billingTermsFromCreateBody) and ' +
            'call buildSchedule; effectiveBillingEnd is not a sanctioned call site outside ' +
            'packages/contract. See docs/PLAN-PHASE2.md Amendment A.2.',
        ).toBe(false);
      });

      it('never passes moveOutDate to minIsoDate / maxIsoDate / compareIsoDate (Amendment A.2)', () => {
        expect(
          MOVE_OUT_DATE_IN_COMPARATOR.test(src),
          `${file} passes \`moveOutDate\` to minIsoDate/maxIsoDate/compareIsoDate. Reading moveOutDate ` +
            "to render it is fine; reasoning about it with these is not — that is effectiveBillingEnd's " +
            'job, and effectiveBillingEnd lives in packages/contract only. See docs/PLAN-PHASE2.md ' +
            'Amendment A.2.',
        ).toBe(false);
      });
    });
  }
});

describe('no-date-arithmetic guard — detectors proven against deliberate violations', () => {
  // Mirrors apps/api's own "recursion proof": the detector logic above is
  // exercised here against throwaway fixture source, in both directions (flags
  // the bad shape, passes the good one), so this guard's failure mode has
  // actually been observed at least once rather than assumed.
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'no-date-arithmetic-fixture-'));

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('flags a local daysInMonth definition, including the const/arrow form', () => {
    expect(
      definesLocalHelper('export function daysInMonth(year: number, month: number) { return 30; }\n', 'daysInMonth'),
    ).toBe(true);
    expect(definesLocalHelper('const isLeapYear = (year: number) => year % 4 === 0;\n', 'isLeapYear')).toBe(true);
  });

  it('does not flag merely importing or calling daysInMonth', () => {
    const src = "import { daysInMonth } from '@rms/contract';\nconst n = daysInMonth(2026, 4);\n";
    expect(definesLocalHelper(src, 'daysInMonth')).toBe(false);
  });

  it('flags `/ 30` and `/ 365`, not an unrelated division or a Tailwind opacity suffix', () => {
    expect(MAGIC_DIVISOR.test('const approxMonths = totalDays / 30;')).toBe(true);
    expect(MAGIC_DIVISOR.test('const approxYears = totalDays / 365;')).toBe(true);
    expect(MAGIC_DIVISOR.test('const half = total / 2;')).toBe(false);
    // A Tailwind class string is stripped to `""` by `stripNoise` before this
    // regex ever sees it — proven end to end against a real file below too.
    expect(MAGIC_DIVISOR.test(stripNoise('const cls = "bg-destructive/30";'))).toBe(false);
  });

  it('flags the legacy multi-argument `new Date(year, month, day)` form', () => {
    const calls = newDateArgLists('const d = new Date(2026, 3, 1);');
    expect(calls).toEqual(['2026, 3, 1']);
    expect(isAllowedNewDateCall(calls[0]!)).toBe(false);
  });

  it('allows a bare `new Date()`, a single instant argument, a duration on `Date.now()`, and `new Date(Date.UTC(...))`', () => {
    expect(isAllowedNewDateCall('')).toBe(true);
    expect(isAllowedNewDateCall('preview.expiresAt')).toBe(true);
    expect(isAllowedNewDateCall('Date.now() + INVITE_TTL_MS')).toBe(true);

    const calls = newDateArgLists('new Date(Date.UTC(year, month - 1, day))');
    expect(calls).toEqual(['Date.UTC(year, month - 1, day)']);
    expect(isAllowedNewDateCall(calls[0]!)).toBe(true);
  });

  it('flags effectiveBillingEnd called directly, allows billingTermsFor/buildSchedule', () => {
    expect(EFFECTIVE_BILLING_END_CALL.test('const end = effectiveBillingEnd(terms);')).toBe(true);
    expect(EFFECTIVE_BILLING_END_CALL.test('buildSchedule(billingTermsFor(lease), through)')).toBe(false);
  });

  it('flags moveOutDate passed to the comparators, allows reading it for display', () => {
    expect(MOVE_OUT_DATE_IN_COMPARATOR.test('minIsoDate(terms.moveOutDate, terms.endDate)')).toBe(true);
    expect(MOVE_OUT_DATE_IN_COMPARATOR.test('maxIsoDate(a, b, terms.moveOutDate)')).toBe(true);
    expect(MOVE_OUT_DATE_IN_COMPARATOR.test('<p>{lease.moveOutDate}</p>')).toBe(false);
  });

  it('a deliberately bad fixture file, written to disk, is caught end to end', () => {
    const badFile = join(fixtureRoot, 'bad-date-math.ts');
    writeFileSync(
      badFile,
      [
        'export function daysInMonth(year: number, month: number): number {',
        '  return 30;',
        '}',
        'export function approxPeriods(totalDays: number): number {',
        '  return totalDays / 30;',
        '}',
        'export function legacyDate(year: number, month: number, day: number): Date {',
        '  return new Date(year, month - 1, day);',
        '}',
        'export function shortenEnd(terms: { moveOutDate: string; endDate: string }): string {',
        '  return minIsoDate(terms.moveOutDate, terms.endDate);',
        '}',
        'export function endOfTerm(terms: unknown): string | null {',
        '  return effectiveBillingEnd(terms as never);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const src = readSource(fixtureRoot, 'bad-date-math.ts');
    expect(definesLocalHelper(src, 'daysInMonth')).toBe(true);
    expect(MAGIC_DIVISOR.test(src)).toBe(true);
    expect(newDateArgLists(src).some((args) => !isAllowedNewDateCall(args))).toBe(true);
    expect(EFFECTIVE_BILLING_END_CALL.test(src)).toBe(true);
    expect(MOVE_OUT_DATE_IN_COMPARATOR.test(src)).toBe(true);
  });

  it('a well-formed fixture file passes every detector', () => {
    const goodFile = join(fixtureRoot, 'good-no-date-math.ts');
    writeFileSync(
      goodFile,
      [
        "import { daysInMonth, billingTermsFor, buildSchedule } from '@rms/contract';",
        'export function describeMonth(year: number, month: number): string {',
        '  return `${daysInMonth(year, month)} days`;',
        '}',
        'export function stampNow(): Date {',
        '  return new Date();',
        '}',
        'export function renderExpiry(iso: string): Date {',
        '  return new Date(iso);',
        '}',
        'export function renderCivilDate(year: number, month: number, day: number): Date {',
        '  return new Date(Date.UTC(year, month - 1, day));',
        '}',
        'export function schedule(lease: unknown, through: string) {',
        '  return buildSchedule(billingTermsFor(lease as never), through as never);',
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
    expect(newDateArgLists(src).every((args) => isAllowedNewDateCall(args))).toBe(true);
    expect(EFFECTIVE_BILLING_END_CALL.test(src)).toBe(false);
    expect(MOVE_OUT_DATE_IN_COMPARATOR.test(src)).toBe(false);
  });
});
