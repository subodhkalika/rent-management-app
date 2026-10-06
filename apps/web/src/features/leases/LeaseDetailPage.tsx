import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Play, RefreshCw, Square, Trash2, X } from 'lucide-react';
import {
  formatMoney,
  leaseStatusLabels,
  rentFrequencyLabels,
  endReasonLabels,
} from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCivilDate } from '@/lib/format-civil-date';
import { useLease } from './api';
import { leaseStatusVariant } from './lease-ui';
import { moveOutBillingCopy } from './frequency-copy';
import { LeaseRosterPanel } from './LeaseRosterPanel';
import { LeaseChainTimeline } from './LeaseChainTimeline';
import { ActivateLeaseDialog } from './ActivateLeaseDialog';
import { CancelLeaseDialog } from './CancelLeaseDialog';
import { EndLeaseDialog } from './EndLeaseDialog';
import { RenewLeaseDialog } from './RenewLeaseDialog';
import { DeleteLeaseDialog } from './DeleteLeaseDialog';

export function LeaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: lease, isPending, isError, error, refetch } = useLease(id ?? '');

  const [activateOpen, setActivateOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!id) return null;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <Link
        to="/leases"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" /> All leases
      </Link>

      <div className="mt-4">
        {isPending ? (
          <LeaseHeaderSkeleton />
        ) : isError ? (
          <LeaseHeaderError code={error.code} message={error.message} onRetry={() => void refetch()} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{lease.unitLabel}</h1>
                  <Badge variant={leaseStatusVariant[lease.status]}>{leaseStatusLabels[lease.status]}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {lease.propertyName} · {lease.primaryTenantName ?? 'No primary tenant yet'}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                {lease.status === 'draft' && (
                  <>
                    <Button variant="outline" onClick={() => setCancelOpen(true)}>
                      <X /> Cancel
                    </Button>
                    <Button variant="outline" onClick={() => setDeleteOpen(true)}>
                      <Trash2 /> Delete
                    </Button>
                    <Button onClick={() => setActivateOpen(true)}>
                      <Play /> Activate
                    </Button>
                  </>
                )}
                {lease.status === 'active' && (
                  <>
                    <Button variant="outline" onClick={() => setRenewOpen(true)}>
                      <RefreshCw /> Renew
                    </Button>
                    <Button variant="outline" onClick={() => setEndOpen(true)}>
                      <Square /> End lease
                    </Button>
                  </>
                )}
                {lease.status === 'ended' && (
                  <Button variant="outline" onClick={() => setRenewOpen(true)}>
                    <RefreshCw /> Renew
                  </Button>
                )}
                {lease.status === 'cancelled' && (
                  <Button variant="outline" onClick={() => setDeleteOpen(true)}>
                    <Trash2 /> Delete
                  </Button>
                )}
              </div>
            </div>

            <LeaseTermsSummary lease={lease} />
          </>
        )}
      </div>

      {lease && (
        <>
          <Tabs defaultValue="roster" className="mt-6">
            <TabsList>
              <TabsTrigger value="roster">Roster</TabsTrigger>
              <TabsTrigger value="chain">Chain</TabsTrigger>
            </TabsList>
            <TabsContent value="roster">
              <LeaseRosterPanel lease={lease} />
            </TabsContent>
            <TabsContent value="chain">
              <LeaseChainTimeline lease={lease} />
            </TabsContent>
          </Tabs>

          <ActivateLeaseDialog open={activateOpen} onOpenChange={setActivateOpen} lease={lease} />
          <CancelLeaseDialog open={cancelOpen} onOpenChange={setCancelOpen} lease={lease} />
          <EndLeaseDialog open={endOpen} onOpenChange={setEndOpen} lease={lease} />
          <RenewLeaseDialog open={renewOpen} onOpenChange={setRenewOpen} lease={lease} />
          <DeleteLeaseDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            lease={lease}
            onDeleted={() => navigate('/leases')}
          />
        </>
      )}
    </main>
  );
}

function LeaseTermsSummary({ lease }: { lease: NonNullable<ReturnType<typeof useLease>['data']> }) {
  return (
    <div className="mt-4 rounded-lg border p-4">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <dt className="text-muted-foreground">Rent</dt>
        <dd className="sm:col-span-2">
          {formatMoney(lease.rentCents, lease.currency)} / {rentFrequencyLabels[lease.rentFrequency].toLowerCase()}
        </dd>
        <dt className="text-muted-foreground">Term</dt>
        <dd className="sm:col-span-2">
          {formatCivilDate(lease.startDate, lease.calendar)} –{' '}
          {lease.endDate ? formatCivilDate(lease.endDate, lease.calendar) : 'rolling'}
        </dd>
        <dt className="text-muted-foreground">Deposit</dt>
        <dd className="sm:col-span-2">{formatMoney(lease.depositCents, lease.currency)}</dd>
        {lease.moveOutDate && (
          <>
            <dt className="text-muted-foreground">Move-out date</dt>
            <dd className="sm:col-span-2">{formatCivilDate(lease.moveOutDate, lease.calendar)}</dd>
          </>
        )}
        {lease.endReason && (
          <>
            <dt className="text-muted-foreground">End reason</dt>
            <dd className="sm:col-span-2">{endReasonLabels[lease.endReason]}</dd>
          </>
        )}
        {lease.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="sm:col-span-2 whitespace-pre-wrap">{lease.notes}</dd>
          </>
        )}
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">
        {moveOutBillingCopy(lease.moveOutBillingPolicy, lease.endDate, lease.calendar)}
      </p>
      {lease.status === 'draft' && (
        <p className="mt-2 flex items-center gap-1 text-sm text-muted-foreground">
          <Pencil className="size-3.5" aria-hidden="true" /> Edit this lease's terms before activating it — most
          fields lock once it's active.
        </p>
      )}
    </div>
  );
}

function LeaseHeaderSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading lease">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function LeaseHeaderError({ code, message, onRetry }: { code: string; message: string; onRetry: () => void }) {
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
