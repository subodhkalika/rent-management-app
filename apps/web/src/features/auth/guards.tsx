import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/lib/auth-client';
import { Skeleton } from '@/components/ui/skeleton';

/** Shown while the session is still resolving — never a sign-in flash, never blank. */
function SessionLoadingSkeleton() {
  return (
    <div className="grid min-h-full place-items-center p-8" aria-busy="true" aria-label="Loading">
      <div className="w-64 space-y-3">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    </div>
  );
}

/**
 * Guards every route that requires a signed-in user with an active organization.
 * - Session still loading -> render a neutral skeleton, nothing that implies a state.
 * - No session -> `/signin`, preserving the intended destination.
 * - Session but no active organization -> `/onboarding`.
 */
export function RequireAuth() {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) return <SessionLoadingSkeleton />;
  if (!session) return <Navigate to="/signin" state={{ from: location }} replace />;
  if (!session.session.activeOrganizationId) return <Navigate to="/onboarding" replace />;

  return <Outlet />;
}

/**
 * Guards `/signin` and `/signup`: a signed-in user has no business seeing a login
 * form again.
 */
export function GuestOnly() {
  const { data: session, isPending } = useSession();

  if (isPending) return <SessionLoadingSkeleton />;
  if (session) {
    return (
      <Navigate to={session.session.activeOrganizationId ? '/properties' : '/onboarding'} replace />
    );
  }

  return <Outlet />;
}

/**
 * Guards `/onboarding`: only reachable signed in with no organization yet. Signed out
 * goes to sign-in; signed in with an org already has nothing to onboard.
 */
export function RequireNoOrganization() {
  const { data: session, isPending } = useSession();

  if (isPending) return <SessionLoadingSkeleton />;
  if (!session) return <Navigate to="/signin" replace />;
  if (session.session.activeOrganizationId) return <Navigate to="/properties" replace />;

  return <Outlet />;
}
