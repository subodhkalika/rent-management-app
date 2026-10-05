import { Link } from 'react-router-dom';
import { leaseStatusLabels } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
    <Link to={`/leases/${lease.id}`} className="inline-flex items-center gap-1.5 hover:underline">
      <Badge variant={leaseStatusVariant[lease.status]}>{leaseStatusLabels[lease.status]}</Badge>
    </Link>
  );
}
