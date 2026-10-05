import { httpStatusFor, type ErrorCode } from '@rms/contract';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The only way to fail a request. Carries a contract error code so the client can
 * branch on a stable value instead of string-matching a message.
 */
export class ApiException extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiException';
  }

  get status(): ContentfulStatusCode {
    return httpStatusFor[this.code] as ContentfulStatusCode;
  }

  toBody() {
    return {
      error: { code: this.code, message: this.message, ...(this.details && { details: this.details }) },
    };
  }
}

export const badRequest = (m: string, d?: Record<string, string[]>) =>
  new ApiException('bad_request', m, d);
export const unauthorized = (m = 'Sign in to continue') => new ApiException('unauthorized', m);
export const forbidden = (m = 'You do not have access to this resource') =>
  new ApiException('forbidden', m);
export const conflict = (m: string) => new ApiException('conflict', m);
export const validationFailed = (d: Record<string, string[]>) =>
  new ApiException('validation_failed', 'Some fields are invalid', d);

/**
 * Returned when a row is absent *or* belongs to another org — deliberately
 * indistinguishable. A 403 on someone else's UUID would confirm the row exists,
 * letting one landlord probe another's portfolio.
 */
export const notFound = (what = 'Resource') => new ApiException('not_found', `${what} not found`);

/**
 * The ONE response for every invite failure — bad token, expired, revoked, already
 * accepted, tenant archived. The sameness is the anti-enumeration property
 * (docs/PLAN-V1.md §1.3): differentiating any of these would tell a caller which
 * guess was "closer". Always this exact message, never a more specific one.
 */
export const inviteInvalid = () =>
  new ApiException('not_found', 'This invitation is no longer valid. Ask your landlord to send a new one.');
