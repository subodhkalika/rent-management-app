import { Link } from 'react-router-dom';
import { leaseStatusLabels } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { BalanceChip } from '@/features/payments/BalanceChip';
import { useLeaseBalance } from '@/features/payments/api';
import { useLeases } from './api';
import { leaseStatusVariant } from './lease-ui';

/** Shown on each unit row in `UnitsSection` (docs/PLAN-PHASE2.md §8.2 item 8 —
 *  "lease cards on the unit detail page", which for this unit list IS the detail
 *  surface for a unit today). Prefers the active lease; falls back to the most
 *  recently created one so a vacant unit with a past tenancy still links
 *  somewhere, rather than looking like it has never been leased. */
export function UnitLeaseCell({ unitId }: { unitId: string }) {
  const { data, isPending, isError } = useLeases({ unitId });

  if (isPending) return <Skeleton className="h-5 w-20" />;
  if (isError) return <span className="text-sm text-muted-foreground">—</span>;

  const items = data.pages[0]?.items ?? [];
  const lease = items.find((l) => l.status === 'active') ?? items.at(-1);

  if (!lease) {
    return <span className="text-sm text-muted-foreground">No lease</span>;
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <Link to={`/leases/${lease.id}`} className="hover:underline">
        <Badge variant={leaseStatusVariant[lease.status]}>{leaseStatusLabels[lease.status]}</Badge>
      </Link>
      <UnitLeaseBalance leaseId={lease.id} currency={lease.currency} />
    </div>
  );
}

/** Quiet while loading — a balance chip is an enhancement on this row, not
 *  something worth a layout-shifting skeleton next to an already-rendered badge. */
function UnitLeaseBalance({ leaseId, currency }: { leaseId: string; currency: Parameters<typeof BalanceChip>[0]['currency'] }) {
  const { data: balance } = useLeaseBalance(leaseId);
  if (!balance) return null;
  return <BalanceChip balanceCents={balance.chain.balanceCents} currency={currency} />;
}
