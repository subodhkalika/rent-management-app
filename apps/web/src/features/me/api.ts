import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { meContext, routes, type MeContext } from '@rms/contract';
import { ApiClientError, request } from '@/lib/api';

/**
 * "Who am I, and in what capacity" — the single source of truth the whole app
 * branches on. Never infer actor type from `session.activeOrganizationId`; a
 * tenant can create their own empty organization (see docs/PLAN-V1.md §1), so
 * "has an org" does not mean "is a landlord". This is what the guards in
 * `features/auth/guards.tsx` and the app shell both read.
 */
export const meKeys = {
  context: ['me', 'context'] as const,
};

export function useMeContext(options?: { enabled?: boolean }): UseQueryResult<
  MeContext,
  ApiClientError
> {
  return useQuery<MeContext, ApiClientError>({
    queryKey: meKeys.context,
    queryFn: ({ signal }) => request(routes.me.context(), { schema: meContext, signal }),
    enabled: options?.enabled ?? true,
    staleTime: 60_000,
  });
}
