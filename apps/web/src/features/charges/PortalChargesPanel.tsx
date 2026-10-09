import { formatMoney, type CalendarSystem, type Currency } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { usePortalLeaseCharges } from '@/features/portal/api';
import { formatOccupied } from './charge-ui';

/**
 * The tenant's statement for one lease (docs/PLAN-PHASE3A.md §9.2, frontend task
 * 6). Prorated rows show "17 of 31 days" — the single most disputed figure in
 * renting, settled without an email. Voided rows are struck through, never
 * hidden. Deliberately NO total anywhere on this screen: a sum with no payments
 * against it changes meaning the moment 3b ships, and showing a tenant they owe
 * an amount they have already paid is worse than showing nothing.
 */
export function PortalChargesPanel({
  leaseId,
  calendar,
  currency,
}: {
  leaseId: string;
  calendar: CalendarSystem;
  currency: Currency;
}) {
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
  } = usePortalLeaseCharges(leaseId);

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mt-6 rounded-lg border p-4">
      <h2 className="text-sm font-medium">Charges</h2>
      <div className="mt-2">
        {isPending ? (
          <PortalChargesSkeleton />
        ) : isError ? (
          <PortalChargesError message={error.message} onRetry={() => void refetch()} />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has been charged yet. Rent and deposit lines appear here once your lease is active.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Due</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id} className={c.isVoided ? 'text-muted-foreground' : undefined}>
                    <TableCell className={c.isVoided ? 'line-through' : undefined}>
                      {formatCivilDate(c.dueDate, calendar)}
                      {c.isVoided && (
                        <Badge variant="outline" className="ml-2">
                          Voided
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className={c.isVoided ? 'line-through' : undefined}>
                      {c.description ?? c.type}
                    </TableCell>
                    <TableCell className={c.isVoided ? 'line-through' : 'text-muted-foreground'}>
                      {c.periodStart && c.periodEnd
                        ? `${formatCivilDate(c.periodStart, calendar)} – ${formatCivilDate(c.periodEnd, calendar)}`
                        : '—'}
                      {c.isProrated && c.daysOccupied !== null && c.daysInPeriod !== null && (
                        <div className="text-xs">{formatOccupied(c.daysOccupied, c.daysInPeriod)}</div>
                      )}
                    </TableCell>
                    <TableCell className={c.isVoided ? 'line-through' : 'font-medium'}>
                      {formatMoney(c.amountCents, currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
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
    </div>
  );
}

function PortalChargesSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading charges">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function PortalChargesError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" aria-live="polite" className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-medium">Couldn't load charges</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
