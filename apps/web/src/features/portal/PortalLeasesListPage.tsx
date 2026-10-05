import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { formatMoney, leaseStatusLabels, rentFrequencyLabels } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { leaseStatusVariant } from '@/features/leases/lease-ui';
import { usePortalLeases } from './api';

export function PortalLeasesListPage() {
  const { data: leases, isPending, isError, error, refetch } = usePortalLeases();

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Your leases</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Every tenancy you're on, across every landlord.
      </p>

      <div className="mt-6">
        {isPending ? (
          <LeasesSkeleton />
        ) : isError ? (
          <LeasesError message={error.message} onRetry={() => void refetch()} />
        ) : leases.length === 0 ? (
          <LeasesEmpty />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>Term</TableHead>
                <TableHead>Rent</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leases.map((lease) => (
                <TableRow key={lease.id}>
                  <TableCell className="font-medium">
                    <Link to={`/portal/leases/${lease.id}`} className="hover:underline focus-visible:underline">
                      {lease.unitLabel}, {lease.propertyName}
                    </Link>
                    {lease.yourRole === 'former' && (
                      <Badge variant="outline" className="ml-2">
                        Former tenant
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatCivilDate(lease.startDate, lease.calendar)} –{' '}
                    {lease.endDate ? formatCivilDate(lease.endDate, lease.calendar) : 'rolling'}
                  </TableCell>
                  <TableCell>
                    {formatMoney(lease.rentCents, lease.currency)}
                    <span className="text-muted-foreground"> / {rentFrequencyLabels[lease.rentFrequency].toLowerCase()}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={leaseStatusVariant[lease.status]}>{leaseStatusLabels[lease.status]}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </main>
  );
}

function LeasesSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading your leases">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function LeasesEmpty() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <FileText className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">No leases yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Once your landlord activates a lease for you, it'll show up here with your rent
          schedule.
        </p>
      </div>
    </div>
  );
}

function LeasesError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load your leases</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
