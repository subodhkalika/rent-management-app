import { formatMoney, type Currency, type CalendarSystem, type PlannedCharge, type Timezone } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { nextDuePeriodIndex } from './next-due';

interface LeaseScheduleTableProps {
  periods: readonly PlannedCharge[];
  currency: Currency;
  calendar: CalendarSystem;
  /** When given, the first not-yet-due period is highlighted — evaluated in the
   *  PROPERTY's own timezone (`next-due.ts`), never the viewer's. Omit on a draft
   *  lease preview, where "due" has no meaning yet. */
  propertyTimezone?: Timezone;
  /** Injectable for tests; defaults to the real clock. */
  now?: Date;
  emptyMessage?: string;
  /** How many further periods exist beyond what's rendered — e.g. the create
   *  wizard caps its preview window. `null`/`0` renders nothing extra. */
  truncatedCount?: number;
}

/**
 * Renders a `PlannedCharge[]` exactly as returned by `buildSchedule` — client-side
 * in the create wizard and the end-lease dialog, or fetched from `GET .../schedule`
 * on an existing lease. Every date goes through `formatCivilDate`, never a raw
 * `Intl`/`toLocaleDateString` call, so a Bikram Sambat property renders its own
 * calendar here too.
 */
export function LeaseScheduleTable({
  periods,
  currency,
  calendar,
  propertyTimezone,
  now,
  emptyMessage = 'No charges fall in this window.',
  truncatedCount,
}: LeaseScheduleTableProps) {
  if (periods.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const nextDueIndex = propertyTimezone ? nextDuePeriodIndex(periods, propertyTimezone, now) : -1;

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead>Due date</TableHead>
            <TableHead>Days</TableHead>
            <TableHead>Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {periods.map((period, index) => (
            <TableRow key={period.generationKey} data-state={index === nextDueIndex ? 'next-due' : undefined}>
              <TableCell>
                {formatCivilDate(period.periodStart, calendar)} – {formatCivilDate(period.periodEnd, calendar)}
                {period.isProrated && (
                  <Badge variant="outline" className="ml-2">
                    Prorated
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                {formatCivilDate(period.dueDate, calendar)}
                {index === nextDueIndex && (
                  <Badge className="ml-2" variant="default">
                    Next due
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {period.daysOccupied}
                {period.daysOccupied !== period.daysInPeriod ? ` of ${period.daysInPeriod}` : ''}
              </TableCell>
              <TableCell className="font-medium">{formatMoney(period.amountCents, currency)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!!truncatedCount && truncatedCount > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {truncatedCount} further {truncatedCount === 1 ? 'period is' : 'periods are'} not shown here.
        </p>
      )}
    </div>
  );
}
