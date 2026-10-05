import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Shared parsing used by every static tenancy guard (`db/repo/tenancy.guard.test.ts`,
 * `db/repo/portal/portal-tenancy.guard.test.ts`, and any future one).
 *
 * Pulled out of the original single guard file so the file-discovery step — the part
 * that was buggy — has exactly one implementation, is unit-testable on its own (see
 * the "recursion proof" describe block in `tenancy.guard.test.ts`), and cannot drift
 * between the landlord guard and the portal guard.
 */

// `selectDistinctOn` listed BEFORE `select`: regex alternation tries branches in
// order at a given position, and does not backtrack a shorter match into a longer
// one — `db.selectDistinctOn(` would silently fail to match (and the tenancy
// guards would silently stop checking the function that called it) if `select`
// were tried first, matched, and then failed its own `\b` boundary check (`t`
// immediately followed by `D` is not a word boundary) — the engine backtracks to
// the next ALTERNATIVE at that same position, never to a longer alternative
// starting at the same point. Caught when `db/repo/portal/lease.ts`'s
// `listLeasesQuery` switched to `selectDistinctOn` for HIGH 7's dedup fix and the
// portal tenancy guard's test count silently dropped.
export const QUERY_VERBS = /\bdb\s*\.\s*(selectDistinctOn|select|insert|update|delete|query)\b/;

/**
 * Every `.ts` source file under `dir`, at any depth, excluding tests and declaration
 * files. Returns paths relative to `dir` with forward slashes, so `portal/scope.ts`
 * reads the same on every OS and a prefix check (`startsWith('portal/')`) is reliable.
 *
 * This MUST recurse. The bug this fixes (docs/PLAN-V1.md §0.2.A): a prior version
 * used a non-recursive `readdirSync`, so `db/repo/portal/*.ts` — which this phase
 * adds — would have been silently invisible to the guard, the moment it existed.
 */
export function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  const out: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;

    // Node >= 20.12 gives Dirent.parentPath; older releases only had the now-
    // deprecated `.path` alias with the same meaning. Try both so this doesn't
    // depend on exactly which patch version is running.
    const parent = (entry as { parentPath?: string; path?: string }).parentPath
      ?? (entry as { path?: string }).path
      ?? dir;
    const full = join(parent, entry.name);
    out.push(relative(dir, full).split(sep).join('/'));
  }

  return out.sort();
}

export interface ParsedFunction {
  name: string;
  params: string;
  body: string;
}

/** Splits a source file into top-level exported functions by brace matching. */
export function exportedFunctions(src: string): ParsedFunction[] {
  const out: ParsedFunction[] = [];
  const header = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;

  for (let m = header.exec(src); m; m = header.exec(src)) {
    const name = m[1]!;
    let i = m.index + m[0].length;

    // Walk the parameter list to its closing paren.
    let depth = 1;
    const paramStart = i;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    const params = src.slice(paramStart, i - 1);

    // Walk to the opening brace, then match it.
    while (i < src.length && src[i] !== '{') i++;
    const bodyStart = ++i;
    depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push({ name, params, body: src.slice(bodyStart, i - 1) });
  }
  return out;
}

/** Strips comments and string literals so a mention inside either never counts. */
export function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** Reads and noise-strips one file under `dir` (as returned by `listSourceFiles`). */
export function readSource(dir: string, relativePath: string): string {
  return stripNoise(readFileSync(join(dir, ...relativePath.split('/')), 'utf8'));
}
