import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { primaryActor } from '@rms/contract';
import { useSession } from '@/lib/auth-client';
import { useMeContext } from '@/features/me/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

/** Shown while the session or `/v1/me/context` is still resolving — never a
 *  sign-in flash, never blank, never the wrong actor's screen for a tick. */
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

/** `/v1/me/context` itself failed (network/500) — distinct from "no session",
 *  which redirects. This is a real error and needs a retry, not a redirect
 *  loop. */
function MeContextError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="grid min-h-full place-items-center p-8">
      <div
        role="alert"
        aria-live="polite"
        className="max-w-sm rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center"
      >
        <h1 className="font-medium">Couldn't load your account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Check your connection and try again.
        </p>
        <Button variant="outline" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/**
 * Resolves session + actor context together. Every guard below is a thin
 * branch on top of this — none of them ever look at
 * `session.activeOrganizationId`, because a tenant can hold one too (see
 * docs/PLAN-V1.md §1 and `packages/contract/src/me.ts`).
 */
function useActorResolution() {
  const { data: session, isPending: sessionPending } = useSession();
  const meQuery = useMeContext({ enabled: !!session });
  return { session, sessionPending, ...meQuery };
}

/**
 * Guards every landlord-only route (`/properties`, `/tenants`, ...).
 * - Session/context still loading -> neutral skeleton.
 * - No session -> `/signin`, preserving the intended destination.
 * - `/v1/me/context` failed -> error with retry.
 * - Signed in but not a landlord -> `/portal` if they're a tenant somewhere,
 *   otherwise `/onboarding`.
 */
export function RequireLandlord() {
  const location = useLocation();
  const { session, sessionPending, data: ctx, isPending, isError, refetch } =
    useActorResolution();

  if (sessionPending) return <SessionLoadingSkeleton />;
  if (!session) return <Navigate to="/signin" state={{ from: location }} replace />;
  if (isPending) return <SessionLoadingSkeleton />;
  if (isError) return <MeContextError onRetry={() => void refetch()} />;

  if (!ctx.landlord) {
    return <Navigate to={ctx.tenancies.length > 0 ? '/portal' : '/onboarding'} replace />;
  }

  return <Outlet />;
}

/**
 * Guards every tenant-portal route (`/portal/*`, except the public
 * `/portal/accept`). Mirrors `RequireLandlord`, branching the other way.
 */
export function RequireTenant() {
  const location = useLocation();
  const { session, sessionPending, data: ctx, isPending, isError, refetch } =
    useActorResolution();

  if (sessionPending) return <SessionLoadingSkeleton />;
  if (!session) return <Navigate to="/signin" state={{ from: location }} replace />;
  if (isPending) return <SessionLoadingSkeleton />;
  if (isError) return <MeContextError onRetry={() => void refetch()} />;

  if (ctx.tenancies.length === 0) {
    return <Navigate to={ctx.landlord ? '/properties' : '/onboarding'} replace />;
  }

  return <Outlet />;
}

/**
 * Guards `/signin` and `/signup`: a signed-in user has no business seeing a
 * login form again. Where they land instead is `primaryActor(ctx)` — the
 * contract's own rule for "landlord wins if present, else tenant, else
 * onboarding" — never a guess based on `activeOrganizationId`.
 */
export function GuestOnly() {
  const { session, sessionPending, data: ctx, isPending, isError, refetch } =
    useActorResolution();

  if (sessionPending) return <SessionLoadingSkeleton />;

  if (session) {
    if (isPending) return <SessionLoadingSkeleton />;
    if (isError) return <MeContextError onRetry={() => void refetch()} />;

    const destination: Record<ReturnType<typeof primaryActor>, string> = {
      landlord: '/properties',
      tenant: '/portal',
      onboarding: '/onboarding',
    };
    return <Navigate to={destination[primaryActor(ctx)]} replace />;
  }

  return <Outlet />;
}

/**
 * Guards `/onboarding`: creating a landlord organization. Reachable by any
 * signed-in user who isn't a landlord yet — including a tenant-only user, who
 * is allowed to also become a landlord (the two principals are independent,
 * see docs/PLAN-V1.md §1.2). Only blocked once they already have one.
 */
export function RequireNoLandlordOrg() {
  const { session, sessionPending, data: ctx, isPending, isError, refetch } =
    useActorResolution();

  if (sessionPending) return <SessionLoadingSkeleton />;
  if (!session) return <Navigate to="/signin" replace />;
  if (isPending) return <SessionLoadingSkeleton />;
  if (isError) return <MeContextError onRetry={() => void refetch()} />;
  if (ctx.landlord) return <Navigate to="/properties" replace />;

  return <Outlet />;
}
