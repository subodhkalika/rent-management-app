import { formatMoney, type CalendarSystem, type Currency } from '@rms/contract';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { formatCivilDate } from '@/lib/format-civil-date';
import { usePortalLeaseBalance } from '@/features/portal/api';

/**
 * "You owe $X" or "You are $X in credit" — never a signed number, and never the
 * word "arrears" (docs/PLAN-PHASE3B.md §7.2). `nextDueDate` is the sub-line: what
 * the tenant actually opened this page to find out.
 */
export function PortalBalanceHeadline({
  leaseId,
  calendar,
  currency,
}: {
  leaseId: string;
  calendar: CalendarSystem;
  currency: Currency;
}) {
  const { data, isPending, isError, error, refetch } = usePortalLeaseBalance(leaseId);

  if (isPending) {
    return (
      <div className="rounded-lg border p-4" aria-busy="true" aria-label="Loading your balance">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-2 h-4 w-32" />
      </div>
    );
  }

  if (isError) {
    return (
      <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
        <p className="text-sm font-medium">Couldn't load your balance</p>
        <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const headline =
    data.creditCents > 0
      ? `You are ${formatMoney(data.creditCents, currency)} in credit`
      : data.outstandingCents > 0
        ? `You owe ${formatMoney(data.outstandingCents, currency)}`
        : "You're all paid up";

  return (
    <div className="rounded-lg border p-4">
      <p className="text-lg font-semibold tracking-tight">{headline}</p>
      {data.overdueCents > 0 && (
        <p className="mt-1 text-sm text-destructive">{formatMoney(data.overdueCents, currency)} of that is overdue</p>
      )}
      {data.depositOutstandingCents > 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          Deposit not yet paid: {formatMoney(data.depositOutstandingCents, currency)}
        </p>
      )}
      {data.nextDueDate && (
        <p className="mt-1 text-sm text-muted-foreground">
          Next due {formatCivilDate(data.nextDueDate, calendar)} · {formatMoney(data.nextDueAmountCents ?? 0, currency)}
        </p>
      )}
    </div>
  );
}
