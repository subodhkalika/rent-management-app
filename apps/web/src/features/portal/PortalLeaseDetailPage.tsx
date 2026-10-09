import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Info } from 'lucide-react';
import { formatMoney, leaseStatusLabels, rentFrequencyLabels } from '@rms/contract';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCivilDate } from '@/lib/format-civil-date';
import { leaseStatusVariant } from '@/features/leases/lease-ui';
import { moveOutBillingCopy } from '@/features/leases/frequency-copy';
import { PortalChargesPanel } from '@/features/charges/PortalChargesPanel';
import { usePortalLease } from './api';

export function PortalLeaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: lease, isPending, isError, error, refetch } = usePortalLease(id ?? '');

  if (!id) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link
        to="/portal/leases"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" /> All your leases
      </Link>

      <div className="mt-4">
        {isPending ? (
          <PageSkeleton />
        ) : isError ? (
          <PageError code={error.code} message={error.message} onRetry={() => void refetch()} />
        ) : (
          <LeaseContent lease={lease} />
        )}
      </div>
    </main>
  );
}

function LeaseContent({ lease }: { lease: NonNullable<ReturnType<typeof usePortalLease>['data']> }) {
  return (
    <>
      {lease.yourRole === 'former' && (
        <Alert className="mb-4">
          <Info />
          <AlertTitle>You're no longer on this lease</AlertTitle>
          <AlertDescription>
            {lease.removedOn
              ? `You left this lease on ${formatCivilDate(lease.removedOn, lease.calendar)}.`
              : 'You are no longer a current tenant on this lease.'}{' '}
            It stays visible because you were jointly responsible for the whole term while
            you were on it, including anything billed after you left.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {lease.unitLabel}, {lease.propertyName}
        </h1>
        <Badge variant={leaseStatusVariant[lease.status]}>{leaseStatusLabels[lease.status]}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{lease.landlordName}</p>

      <div className="mt-4 rounded-lg border p-4">
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <dt className="text-muted-foreground">Rent</dt>
          <dd className="sm:col-span-2">
            {formatMoney(lease.rentCents, lease.currency)} /{' '}
            {rentFrequencyLabels[lease.rentFrequency].toLowerCase()}
          </dd>
          <dt className="text-muted-foreground">Term</dt>
          <dd className="sm:col-span-2">
            {formatCivilDate(lease.startDate, lease.calendar)} –{' '}
            {lease.endDate ? formatCivilDate(lease.endDate, lease.calendar) : 'rolling'}
          </dd>
          <dt className="text-muted-foreground">Deposit</dt>
          <dd className="sm:col-span-2">{formatMoney(lease.depositCents, lease.currency)}</dd>
          <dt className="text-muted-foreground">Co-tenants</dt>
          <dd className="sm:col-span-2">
            {lease.coTenants.length === 0
              ? 'None'
              : lease.coTenants
                  .map(
                    (t) =>
                      `${t.firstName} ${t.lastName}${t.isPrimary ? ' (primary)' : ''}${t.isCurrent ? '' : ' (former)'}`,
                  )
                  .join(', ')}
          </dd>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          {moveOutBillingCopy(lease.moveOutBillingPolicy, lease.endDate, lease.calendar)}
        </p>
      </div>

      <PortalChargesPanel leaseId={lease.id} calendar={lease.calendar} currency={lease.currency} />
    </>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading lease">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

function PageError({ code, message, onRetry }: { code: string; message: string; onRetry: () => void }) {
  return (
    <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/30 bg-destructive/5 p-6">
      <h1 className="font-medium">{code === 'not_found' ? 'Lease not found' : "Couldn't load this lease"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {code !== 'not_found' && (
        <Button variant="outline" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
