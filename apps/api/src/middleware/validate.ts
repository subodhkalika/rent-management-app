import type { Context, MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import { validationFailed } from '../lib/errors.js';
import type { AppBindings } from '../types.js';

/** Flattens a Zod error into the contract's `details` shape: field -> messages. */
function toDetails(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/** Validates and REPLACES the JSON body with the parsed value, so handlers get
 *  coerced, defaulted, stripped data rather than whatever the client sent.
 *  Retrieve it in a handler with `parsedBody<T>(c)`. */
export function validateBody<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw validationFailed({ _: ['Request body must be valid JSON'] });
    }
    const result = schema.safeParse(raw);
    if (!result.success) throw validationFailed(toDetails(result.error));
    c.set('body', result.data);
    await next();
  };
}

/** Validates the query string. Retrieve it in a handler with `parsedQuery<T>(c)`. */
export function validateQuery<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const result = schema.safeParse(c.req.query());
    if (!result.success) throw validationFailed(toDetails(result.error));
    c.set('query', result.data);
    await next();
  };
}

/**
 * Typed retrieval for a body validated upstream by `validateBody(schema)` in the
 * same route's middleware chain. `c.get('body')` is `unknown` by design (see
 * `types.ts`) since Hono can't tie the stored value's type to which schema a given
 * route validated against — this is the one explicit cast, done once here instead
 * of at every call site.
 */
export function parsedBody<T>(c: Context<AppBindings>): T {
  return c.get('body') as T;
}

/** Typed retrieval for a query validated upstream by `validateQuery(schema)`. */
export function parsedQuery<T>(c: Context<AppBindings>): T {
  return c.get('query') as T;
}
