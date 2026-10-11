import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSignOut } from './use-sign-out';
import { meKeys } from '@/features/me/api';

const signOut = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/auth-client', () => ({ signOut: (...a: unknown[]) => signOut(...a) }));

describe('useSignOut', () => {
  it("forgets the previous person's actor context", async () => {
    // The bug: signing out cleared the cookie but not the cache, so the next person
    // to sign up on this browser was routed by the last person's `landlord`. The
    // guard let /properties render, the API 403'd because the NEW user had no
    // organization, the redirect listener bounced to /onboarding, which read the
    // same stale landlord and bounced straight back — and the refetch that would
    // have corrected it was cancelled by the churn every time.
    const queryClient = new QueryClient();
    queryClient.setQueryData(meKeys.context, {
      user: { id: 'previous-user', name: 'Previous', email: 'prev@x.com' },
      landlord: { orgId: 'org_previous', orgName: 'Previous Lettings', role: 'owner' },
      tenancies: [],
    });
    queryClient.setQueryData(['properties', 'list'], [{ id: 'p1' }]);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSignOut(), { wrapper });

    await act(async () => { await result.current(); });

    expect(signOut).toHaveBeenCalled();
    expect(queryClient.getQueryData(meKeys.context)).toBeUndefined();
    // Not just the one key: every cached answer belonged to the person leaving.
    expect(queryClient.getQueryData(['properties', 'list'])).toBeUndefined();
  });
});
