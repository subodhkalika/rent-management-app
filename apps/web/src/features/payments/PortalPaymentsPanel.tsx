import { formatMoney, paymentMethodLabels, type CalendarSystem, type Currency } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { usePortalLeasePayments } from '@/features/portal/api';
import { paymentKindVariant } from './payment-ui';

/**
 * The tenant's own payment history for one lease (docs/PLAN-PHASE3B.md §7.1,
 * frontend task 8). No `note` (the landlord's private margin) and no
 * `voidedReason` — only `isVoided`, so a cancelled line is visible without
 * exposing why. No ledger, no running balance: `PortalBalanceHeadline` carries
 * the one number this page needs, on a separate call (§7.4 — a tenant gets a
 * statement, not a reconciliation tool).
 */
export function PortalPaymentsPanel({
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
  } = usePortalLeasePayments(leaseId);

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mt-6 rounded-lg border p-4">
      <h2 className="text-sm font-medium">Payments</h2>
      <div className="mt-2">
        {isPending ? (
          <PortalPaymentsSkeleton />
        ) : isError ? (
          <PortalPaymentsError message={error.message} onRetry={() => void refetch()} />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing recorded yet. Once the landlord records a payment, it appears here.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((p) => (
                  <TableRow key={p.id} className={p.isVoided ? 'text-muted-foreground' : undefined}>
                    <TableCell className={p.isVoided ? 'line-through' : undefined}>
                      {formatCivilDate(p.receivedOn, calendar)}
                      {p.isVoided && (
                        <Badge variant="outline" className="ml-2">
                          Voided
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className={p.isVoided ? 'line-through' : undefined}>
                      <Badge variant={paymentKindVariant[p.kind]}>{p.kind === 'refund' ? 'Refund' : 'Payment'}</Badge>
                    </TableCell>
                    <TableCell className={p.isVoided ? 'line-through' : 'text-muted-foreground'}>
                      {paymentMethodLabels[p.method as keyof typeof paymentMethodLabels] ?? p.method}
                    </TableCell>
                    <TableCell className={p.isVoided ? 'line-through' : 'text-muted-foreground'}>
                      {p.reference ?? '—'}
                    </TableCell>
                    <TableCell className={p.isVoided ? 'line-through' : 'font-medium'}>
                      {formatMoney(p.amountCents, currency)}
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

function PortalPaymentsSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading payments">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function PortalPaymentsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" aria-live="polite" className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-medium">Couldn't load payments</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
