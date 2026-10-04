import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import { validationFailed } from '../lib/errors.js';

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
 *  coerced, defaulted, stripped data rather than whatever the client sent. */
export function validateBody<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw validationFailed({ _: ['Request body must be valid JSON'] });
    }
    const result = schema.safeParse(raw);
    if (!result.success) throw validationFailed(toDetails(result.error));
    c.set('body' as never, result.data as never);
    await next();
  };
}

export function validateQuery<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler {
  return async (c, next) => {
    const result = schema.safeParse(c.req.query());
    if (!result.success) throw validationFailed(toDetails(result.error));
    c.set('query' as never, result.data as never);
    await next();
  };
}
