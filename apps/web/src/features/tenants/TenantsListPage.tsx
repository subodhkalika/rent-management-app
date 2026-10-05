import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Plus } from 'lucide-react';
import { tenantFullName, tenantStatusLabels, portalAccessLabels } from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTenants } from './api';
import { TenantFormDialog } from './TenantFormDialog';

export function TenantsListPage() {
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useTenants();
  const [addOpen, setAddOpen] = useState(false);
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The people renting from you, and whether they have portal access.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus /> Add tenant
        </Button>
      </div>

      <div className="mt-6">
        {isPending ? (
          <TenantsListSkeleton />
        ) : isError ? (
          <TenantsListError message={error.message} onRetry={() => void refetch()} />
        ) : items.length === 0 ? (
          <TenantsListEmpty onAdd={() => setAddOpen(true)} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Portal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((t) => (
                  <TableRow key={t.id} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link
                        to={`/tenants/${t.id}`}
                        className="focus-visible:underline hover:underline"
                      >
                        {tenantFullName(t)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.email ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{t.phone ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{tenantStatusLabels[t.status]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.portalAccess === 'active' ? 'default' : 'secondary'}>
                        {portalAccessLabels[t.portalAccess]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button
                  variant="outline"
                  onClick={() => void fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
        {isFetching && !isPending && !isFetchingNextPage && (
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            Refreshing…
          </p>
        )}
      </div>

      <TenantFormDialog open={addOpen} onOpenChange={setAddOpen} />
    </main>
  );
}

function TenantsListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading tenants">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function TenantsListEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <Users className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">No tenants yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A tenant is a person you manage leases for. Add your first one to start tracking
          leases, payments and portal access.
        </p>
      </div>
      <Button onClick={onAdd}>
        <Plus /> Add tenant
      </Button>
    </div>
  );
}

function TenantsListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load tenants</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
