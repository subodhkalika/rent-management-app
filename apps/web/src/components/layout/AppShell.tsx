import { useEffect, useState } from 'react';
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

  const [selected, setSelected] = useState<TenancyContext | undefined>(ctx?.tenancies[0]);
  useEffect(() => {
    if (!ctx) return;
    // Keep the selection valid if the tenancy list changes under us (e.g. a
    // landlord revokes this tenant mid-session) and seed it the first time.
    setSelected((current) => {
      if (current && ctx.tenancies.some((t) => t.tenantId === current.tenantId)) return current;
      return ctx.tenancies[0];
    });
  }, [ctx]);

  const handleSignOut = async () => {
    await signOut();
    navigate('/signin', { replace: true });
  };

  const showActorSwitch = !!ctx?.landlord && (ctx?.tenancies.length ?? 0) > 0;

  const body = (
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
            ctx.tenancies.length > 1 && selected ? (
              <TenancySwitcher
                tenancies={ctx.tenancies}
                selected={selected}
                onSelect={setSelected}
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                {ctx.tenancies[0]?.orgName ?? 'No tenancy'}
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

      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );

  if (!isPortalRoute || !selected) return body;

  return (
    <PortalTenancyCtx.Provider
      value={{ selected, tenancies: ctx?.tenancies ?? [], setSelected }}
    >
      {body}
    </PortalTenancyCtx.Provider>
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
