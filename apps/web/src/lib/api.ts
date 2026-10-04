import { apiError, type ApiError, type ErrorCode } from '@rms/contract';
import type { z } from 'zod';

/** Empty in dev — the Vite proxy forwards to the Worker, keeping cookies same-origin. */
const BASE = import.meta.env.VITE_API_URL ?? '';

/**
 * A failed API call. Carries the contract error code so callers branch on a stable
 * value, plus per-field `details` for wiring server-side validation back into a form.
 */
export class ApiClientError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }

  get isAuth() {
    return this.code === 'unauthorized' || this.code === 'forbidden';
  }
}

interface RequestOptions<TRes extends z.ZodTypeAny> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Response schema from @rms/contract. The response is parsed through it, so a
   *  server/client drift fails loudly here instead of as `undefined` three
   *  components deep. */
  schema: TRes;
  signal?: AbortSignal;
}

export async function request<TRes extends z.ZodTypeAny>(
  path: string,
  { method = 'GET', body, schema, signal }: RequestOptions<TRes>,
): Promise<z.infer<TRes>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include', // session cookie
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiClientError('internal', 'Could not reach the server. Check your connection.', 0);
  }

  if (!res.ok) {
    const parsed = apiError.safeParse(await res.json().catch(() => null));
    const e: ApiError['error'] | undefined = parsed.success ? parsed.data.error : undefined;
    throw new ApiClientError(
      e?.code ?? 'internal',
      e?.message ?? `Request failed (${res.status})`,
      res.status,
      e?.details,
    );
  }

  if (res.status === 204) return undefined as z.infer<TRes>;

  const result = schema.safeParse(await res.json());
  if (!result.success) {
    // The server returned something the contract does not describe. Surfacing it as
    // an error beats letting malformed data flow into the UI.
    console.error('Response failed contract validation:', result.error.issues);
    throw new ApiClientError('internal', 'The server sent an unexpected response', res.status);
  }
  return result.data;
}
