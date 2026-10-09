import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, RefreshCw, Receipt } from 'lucide-react';
import { formatMoney, chargeOverdue, chargeTypeLabels, localToday, type Charge, type LeaseDetail } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { errorMessage } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { useGenerateCharges, useLeaseCharges } from './api';
import { chargeTypeVariant, formatOccupied } from './charge-ui';
import { DriftBanner } from './DriftBanner';
import { VoidChargeDialog } from './VoidChargeDialog';
import { CorrectChargeDialog } from './CorrectChargeDialog';
import { CreateChargeDialog } from './CreateChargeDialog';

/**
 * The Charges tab on `LeaseDetailPage`: every written row, ordered by due date
 * (the server's own `ORDER BY due_date, id`), overdue decided in the PROPERTY'S
 * own timezone (`chargeOverdue(dueDate, localToday(propertyTimezone))`) — never
 * the browser's clock, because a charge is not late just because the person
 * looking at it is somewhere else (docs/PLAN-PHASE3A.md §9/"Two details worth
 * getting right"). Voided rows are struck through, never hidden, with a link to
 * whatever superseded them.
 */
export function ChargesPanel({ lease }: { lease: LeaseDetail }) {
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
  } = useLeaseCharges(lease.id, { includeVoided: true });
  const generateMutation = useGenerateCharges(lease.id);

  const [createOpen, setCreateOpen] = useState(false);
  const [voidCharge, setVoidCharge] = useState<Charge | null>(null);
  const [correctCharge, setCorrectCharge] = useState<Charge | null>(null);

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const today = localToday(lease.propertyTimezone);

  // Only within currently loaded rows — a chain that spans a page boundary (rare:
  // a correction's new due date lands on another page) does not link, the same
  // limitation every paginated list in this app already has.
  const successorByOriginal = useMemo(() => {
    const map = new Map<string, Charge>();
    for (const c of items) {
      if (c.supersedesChargeId) map.set(c.supersedesChargeId, c);
    }
    return map;
  }, [items]);

  // Nothing is ever generated for a draft or cancelled lease (§9.1: both 409 on
  // `/charges/generate` and `/charges`), and neither status has ever had a charge
  // written — so the only drift kind that could ever appear is `missing`, firing on
  // every scheduled period before the lease is even activated. Suppress the banner
  // entirely for the same statuses the generator itself refuses, rather than
  // showing an alarming banner with an action guaranteed to 409.
  const canHaveCharges = lease.status !== 'draft' && lease.status !== 'cancelled';

  function handleGenerate() {
    generateMutation.mutate(undefined, {
      onSuccess: ({ created }) => {
        toast.success(created.length > 0 ? `${created.length} charge(s) generated` : 'Nothing new to generate');
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  }

  return (
    <div>
      {canHaveCharges && (
        <DriftBanner lease={lease} onReviewCharge={setCorrectCharge} onVoidCharge={setVoidCharge} />
      )}

      <div className="mt-4 flex items-center justify-between">
        <h2 className="text-sm font-medium">Charges</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handleGenerate} disabled={generateMutation.isPending}>
            <RefreshCw /> {generateMutation.isPending ? 'Generating…' : 'Generate charges'}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> Add charge
          </Button>
        </div>
      </div>

      <div className="mt-2">
        {isPending ? (
          <ChargesSkeleton />
        ) : isError ? (
          <ChargesError message={error.message} onRetry={() => void refetch()} />
        ) : items.length === 0 ? (
          <ChargesEmpty onGenerate={handleGenerate} onAdd={() => setCreateOpen(true)} generating={generateMutation.isPending} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Due</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => {
                  const overdue = !c.voidedAt && chargeOverdue(c.dueDate, today);
                  const successor = successorByOriginal.get(c.id);
                  return (
                    <TableRow key={c.id} className={cn(c.voidedAt && 'text-muted-foreground')}>
                      <TableCell className={cn(c.voidedAt && 'line-through')}>
                        {formatCivilDate(c.dueDate, lease.calendar)}
                        {overdue && (
                          <Badge variant="destructive" className="ml-2">
                            Overdue
                          </Badge>
                        )}
                        {c.voidedAt && (
                          <Badge variant="outline" className="ml-2">
                            Voided
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={cn(c.voidedAt && 'line-through')}>
                        <Badge variant={chargeTypeVariant[c.type]}>{chargeTypeLabels[c.type]}</Badge>
                      </TableCell>
                      <TableCell className={cn('text-muted-foreground', c.voidedAt && 'line-through')}>
                        {c.periodStart && c.periodEnd
                          ? `${formatCivilDate(c.periodStart, lease.calendar)} – ${formatCivilDate(c.periodEnd, lease.calendar)}`
                          : '—'}
                        {c.isProrated && c.daysOccupied !== null && c.daysInPeriod !== null && (
                          <div className="text-xs">{formatOccupied(c.daysOccupied, c.daysInPeriod)}</div>
                        )}
                      </TableCell>
                      <TableCell className={cn('font-medium', c.voidedAt && 'line-through')}>
                        {formatMoney(c.amountCents, c.currency)}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.voidedAt ? (
                          successor ? (
                            <span className="text-xs text-muted-foreground">
                              Superseded — {formatMoney(successor.amountCents, successor.currency)} due{' '}
                              {formatCivilDate(successor.dueDate, lease.calendar)}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground" title={c.voidedReason ?? undefined}>
                              {c.voidedReason}
                            </span>
                          )
                        ) : (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setCorrectCharge(c)}>
                              Correct
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setVoidCharge(c)}>
                              Void
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
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

      <CreateChargeDialog open={createOpen} onOpenChange={setCreateOpen} leaseId={lease.id} calendar={lease.calendar} />
      <VoidChargeDialog
        open={voidCharge !== null}
        onOpenChange={(open) => !open && setVoidCharge(null)}
        leaseId={lease.id}
        charge={voidCharge}
        calendar={lease.calendar}
      />
      <CorrectChargeDialog
        open={correctCharge !== null}
        onOpenChange={(open) => !open && setCorrectCharge(null)}
        leaseId={lease.id}
        charge={correctCharge}
        calendar={lease.calendar}
        currency={lease.currency}
      />
    </div>
  );
}

function ChargesSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading charges">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function ChargesEmpty({
  onGenerate,
  onAdd,
  generating,
}: {
  onGenerate: () => void;
  onAdd: () => void;
  generating: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <Receipt className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">No charges yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A charge is a single rent, deposit or fee line this lease owes. Activating a lease generates its rent
          and deposit charges automatically — or run generation here, or add a one-off charge by hand.
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={onGenerate} disabled={generating}>
          <RefreshCw /> {generating ? 'Generating…' : 'Generate charges'}
        </Button>
        <Button onClick={onAdd}>
          <Plus /> Add charge
        </Button>
      </div>
    </div>
  );
}

function ChargesError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load charges</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
