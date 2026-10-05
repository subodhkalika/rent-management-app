import { Link } from 'react-router-dom';
import { formatMoney, leaseStatusLabels, type LeaseDetail } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { formatCivilDate } from '@/lib/format-civil-date';
import { leaseStatusVariant } from './lease-ui';

/** Every predecessor and successor sharing this lease's `chainId` — a renewal
 *  creates a new row, never edits the old one (docs/PLAN-PHASE2.md §5.3). */
export function LeaseChainTimeline({ lease }: { lease: LeaseDetail }) {
  if (lease.chain.length <= 1) {
    return <p className="text-sm text-muted-foreground">This lease has not been renewed.</p>;
  }

  return (
    <ol className="space-y-2">
      {lease.chain.map((entry) => (
        <li
          key={entry.id}
          className={`flex items-center justify-between rounded-md border p-3 text-sm ${
            entry.id === lease.id ? 'border-primary' : ''
          }`}
        >
          <div>
            <Link to={`/leases/${entry.id}`} className="font-medium hover:underline">
              {formatCivilDate(entry.startDate, lease.calendar)} –{' '}
              {entry.endDate ? formatCivilDate(entry.endDate, lease.calendar) : 'rolling'}
            </Link>
            {entry.id === lease.id && <span className="ml-2 text-muted-foreground">(this lease)</span>}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground">{formatMoney(entry.rentCents, lease.currency)}</span>
            <Badge variant={leaseStatusVariant[entry.status]}>{leaseStatusLabels[entry.status]}</Badge>
          </div>
        </li>
      ))}
    </ol>
  );
}
