import { Outlet, useNavigate } from 'react-router-dom';
import { Building2, LogOut, User } from 'lucide-react';
import { signOut, useSession, useActiveOrganization } from '@/lib/auth-client';
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

/** Persistent header for every signed-in route: app name, active org, user menu. */
export function AppShell() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: activeOrganization, isPending: isOrgPending } = useActiveOrganization();

  const handleSignOut = async () => {
    await signOut();
    navigate('/signin', { replace: true });
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Building2 className="size-5 text-primary" aria-hidden="true" />
          <span className="font-semibold tracking-tight">RMS</span>
          <span className="text-muted-foreground" aria-hidden="true">
            /
          </span>
          {isOrgPending ? (
            <Skeleton className="h-4 w-24" />
          ) : (
            <span className="text-sm text-muted-foreground">
              {activeOrganization?.name ?? 'No organization'}
            </span>
          )}
        </div>

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
      </header>

      <div className="flex-1">
        <Outlet />
      </div>
    </div>
  );
}
