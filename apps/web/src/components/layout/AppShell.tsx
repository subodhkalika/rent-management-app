import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Building2, ChevronDown, LogOut, User } from 'lucide-react';
import type { TenancyContext } from '@rms/contract';
import { signOut, useSession } from '@/lib/auth-client';
import { useMeContext } from '@/features/me/api';
import { PortalTenancyCtx } from '@/features/portal/tenancy-context';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Persistent header for every signed-in route, landlord or tenant. One shell,
 * not two: which chrome it shows in the middle — a landlord's organization
 * name, or a tenant's tenancy (with a switcher if they have more than one) —
 * is decided from `/v1/me/context` and the current path, never from
 * `session.activeOrganizationId`. When a user is both a landlord and
 * somebody's tenant, an actor switch appears so they can move between "My
 * properties" and "My tenancies".
 */
export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session } = useSession();
  const { data: ctx } = useMeContext();
  const isPortalRoute = location.pathname.startsWith('/portal');

  // Derived every render, not seeded once via an effect: a user's explicit
  // pick (`manualSelection`) wins as long as it's still a live tenancy,
  // otherwise it falls back to the first one. This has no "before the
  // effect has run" window, so there is no tick where a portal route can
  // render with a stale or missing selection — see the crash this guarded
  // against in review (AppShell rendering `<Outlet/>` without the provider
  // whenever `selected` raced ahead of `ctx`).
  const [manualSelection, setManualSelection] = useState<TenancyContext | undefined>(undefined);
  const tenancies = ctx?.tenancies ?? [];
  const selected =
    manualSelection && tenancies.some((t) => t.tenantId === manualSelection.tenantId)
      ? manualSelection
      : tenancies[0];

  const handleSignOut = async () => {
    await signOut();
    navigate('/signin', { replace: true });
  };

  const showActorSwitch = !!ctx?.landlord && tenancies.length > 0;

  // The content area never renders `<Outlet/>` directly on a portal route
  // unless `PortalTenancyCtx` is provided alongside it, with a real,
  // non-null `selected` tenancy. There is no code path where a portal
  // screen can mount and call `useSelectedTenancy()` without a provider
  // above it — if the tenancy can't be resolved yet (or at all), a fallback
  // renders in its place instead of `<Outlet/>`.
  let content: React.ReactNode;
  if (!isPortalRoute) {
    content = <Outlet />;
  } else if (selected) {
    content = (
      <PortalTenancyCtx.Provider value={{ selected, tenancies, setSelected: setManualSelection }}>
        <Outlet />
      </PortalTenancyCtx.Provider>
    );
  } else {
    content = <PortalShellFallback loading={!ctx} />;
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Building2 className="size-5 text-primary" aria-hidden="true" />
          <span className="font-semibold tracking-tight">RMS</span>
          <span className="text-muted-foreground" aria-hidden="true">
            /
          </span>

          {!ctx ? (
            <Skeleton className="h-4 w-24" />
          ) : isPortalRoute ? (
            tenancies.length > 1 && selected ? (
              <TenancySwitcher
                tenancies={tenancies}
                selected={selected}
                onSelect={setManualSelection}
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                {selected?.orgName ?? 'No tenancy'}
              </span>
            )
          ) : (
            <span className="text-sm text-muted-foreground">
              {ctx.landlord?.orgName ?? 'No organization'}
            </span>
          )}

          {ctx && !isPortalRoute && (
            <nav className="ml-4 flex items-center gap-4 text-sm" aria-label="Landlord">
              <Link
                to="/properties"
                className={cn(
                  'transition-colors',
                  location.pathname.startsWith('/properties')
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Properties
              </Link>
              <Link
                to="/tenants"
                className={cn(
                  'transition-colors',
                  location.pathname.startsWith('/tenants')
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Tenants
              </Link>
              <Link
                to="/leases"
                className={cn(
                  'transition-colors',
                  location.pathname.startsWith('/leases')
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Leases
              </Link>
              <Link
                to="/charges"
                className={cn(
                  'transition-colors',
                  location.pathname.startsWith('/charges')
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Charges
              </Link>
            </nav>
          )}

          {ctx && isPortalRoute && (
            <nav className="ml-4 flex items-center gap-4 text-sm" aria-label="Tenant">
              <Link
                to="/portal/leases"
                className={cn(
                  'transition-colors',
                  location.pathname.startsWith('/portal/leases')
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                My leases
              </Link>
              <Link
                to="/portal/profile"
                className={cn(
                  'transition-colors',
                  location.pathname.startsWith('/portal/profile')
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                My profile
              </Link>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-2">
          {showActorSwitch && (
            <nav className="flex items-center gap-1 rounded-md border p-0.5" aria-label="Switch view">
              <Link
                to="/properties"
                className={cn(
                  'rounded-sm px-2 py-1 text-xs font-medium transition-colors',
                  !isPortalRoute
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-current={!isPortalRoute ? 'page' : undefined}
              >
                My properties
              </Link>
              <Link
                to="/portal"
                className={cn(
                  'rounded-sm px-2 py-1 text-xs font-medium transition-colors',
                  isPortalRoute
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                aria-current={isPortalRoute ? 'page' : undefined}
              >
                My tenancies
              </Link>
            </nav>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2">
                <User className="size-4" aria-hidden="true" />
                {session?.user.name ?? 'Account'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{session?.user.email}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleSignOut()}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex-1">{content}</div>
    </div>
  );
}

/** Rendered on a `/portal/*` route in place of `<Outlet/>` whenever there is
 *  no live tenancy to select yet — either `/v1/me/context` is still
 *  resolving, or (defensively; `RequireTenant` should already have routed
 *  this away) the tenancy list is empty. Either way, this is a real,
 *  degraded screen, not a crash. */
function PortalShellFallback({ loading }: { loading: boolean }) {
  if (loading) {
    return (
      <div className="p-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-24 w-full max-w-2xl" />
      </div>
    );
  }
  return (
    <div className="p-6">
      <p className="text-sm text-muted-foreground">
        You don't have an active tenancy to show right now.
      </p>
    </div>
  );
}

function TenancySwitcher({
  tenancies,
  selected,
  onSelect,
}: {
  tenancies: readonly TenancyContext[];
  selected: TenancyContext;
  onSelect: (tenancy: TenancyContext) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1 text-sm text-muted-foreground">
          {selected.orgName}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Your tenancies</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tenancies.map((tenancy) => (
          <DropdownMenuItem
            key={tenancy.tenantId}
            onSelect={() => onSelect(tenancy)}
            aria-current={tenancy.tenantId === selected.tenantId ? 'true' : undefined}
          >
            {tenancy.orgName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
