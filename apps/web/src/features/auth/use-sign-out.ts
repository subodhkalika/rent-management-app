import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { signOut } from '@/lib/auth-client';

/**
 * Sign out, and forget everything the previous person's session answered.
 *
 * Signing out clears the cookie but not the query cache, and the cache is where the
 * app keeps "who am I and in what capacity". Left behind, the next person to sign in
 * on this browser is routed by the last person's answer — which was not a theoretical
 * risk: signing out and signing up again sent the new account to /properties on a
 * cached `landlord`, got a 403 it could not have avoided, bounced to /onboarding,
 * read the same stale landlord, and bounced back. The refetch that would have
 * corrected it was cancelled by the navigation churn every time, so the loop could
 * not break itself.
 *
 * `clear()` rather than invalidating the one key: every cached query belonged to the
 * person leaving, and a stale property list is nobody else's business either.
 */
export function useSignOut() {
  const queryClient = useQueryClient();

  return useCallback(async () => {
    await signOut();
    queryClient.clear();
  }, [queryClient]);
}
