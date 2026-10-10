import { Link } from 'react-router-dom';
import { formatMoney, leaseStatusLabels, rentFrequencyLabels, type Currency } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCivilDate } from '@/lib/format-civil-date';
import { BalanceChip } from '@/features/payments/BalanceChip';
import { useLeaseBalance } from '@/features/payments/api';
import { useLeases } from './api';
import { leaseStatusVariant } from './lease-ui';

/** Lease cards on the tenant detail page (docs/PLAN-PHASE2.md §8.2 item 8). */
export function TenantLeasesCard({ tenantId }: { tenantId: string }) {
  const { data, isPending, isError, error } = useLeases({ tenantId });
  const items = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <h2 className="text-sm font-medium">Leases</h2>
      <div className="mt-2">
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't load leases: {error.message}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not on any lease yet.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((lease) => (
              <li key={lease.id} className="flex items-center justify-between rounded-md border p-3 text-sm">
                <Link to={`/leases/${lease.id}`} className="font-medium hover:underline">
                  {lease.unitLabel}, {lease.propertyName}
                </Link>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>
                    {formatMoney(lease.rentCents, lease.currency)} /{' '}
                    {rentFrequencyLabels[lease.rentFrequency].toLowerCase()}
                  </span>
                  <span>
                    {formatCivilDate(lease.startDate, lease.calendar)} –{' '}
                    {lease.endDate ? formatCivilDate(lease.endDate, lease.calendar) : 'rolling'}
                  </span>
                  <Badge variant={leaseStatusVariant[lease.status]}>{leaseStatusLabels[lease.status]}</Badge>
                  <TenantLeaseBalance leaseId={lease.id} currency={lease.currency} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Quiet while loading, same reasoning as `UnitLeaseCell`'s own chip. */
function TenantLeaseBalance({ leaseId, currency }: { leaseId: string; currency: Currency }) {
  const { data: balance } = useLeaseBalance(leaseId);
  if (!balance) return null;
  return <BalanceChip balanceCents={balance.chain.balanceCents} currency={currency} />;
}
