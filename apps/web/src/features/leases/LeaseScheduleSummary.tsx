import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  formatMoney,
  rentFrequencyLabels,
  type Currency,
  type CalendarSystem,
  type PlannedCharge,
  type RentFrequency,
  type Timezone,
} from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatCivilDate } from '@/lib/format-civil-date';
import { LeaseScheduleTable } from './LeaseScheduleTable';
import { groupScheduleByAmount, scheduleTotalCents, labelForGroup, type ScheduleGroup } from './schedule-summary';

interface LeaseScheduleSummaryProps {
  periods: readonly PlannedCharge[];
  currency: Currency;
  calendar: CalendarSystem;
  rentFrequency: RentFrequency;
  /** Passed straight through to the expanded full table's "next due" row —
   *  see `LeaseScheduleTable`. Omit on a draft preview, where "due" means nothing. */
  propertyTimezone?: Timezone;
  /** Injectable for tests; defaults to the real clock. */
  now?: Date;
  emptyMessage?: string;
  /** How many further periods exist beyond what's rendered — e.g. the create
   *  wizard caps its preview window. `null`/`0` renders nothing extra. */
  truncatedCount?: number;
}

/**
 * The shared shape for every screen that shows a lease's billing schedule: the
 * create wizard's review step, the lease detail page's Schedule tab, the tenant
 * portal's lease detail, and the end-lease dialog's live preview. One component,
 * not four variants, so the landlord and the tenant always see the same shape.
 *
 * A long lease at one rate used to render one row per period — 34 identical rows
 * either side of the two that actually carry information. This collapses
 * consecutive equal-amount periods into one line (`groupScheduleByAmount`) and
 * always shows every prorated period in full, with the total over the term added
 * up once instead of by hand. The full period-by-period table is still one click
 * away, behind a disclosure, for reconciling against a bank statement.
 *
 * Presentation only: every date and amount here is copied straight out of the
 * `PlannedCharge[]` `buildSchedule` produced. Nothing in this file or in
 * `schedule-summary.ts` adds, subtracts or shifts one.
 */
export function LeaseScheduleSummary({
  periods,
  currency,
  calendar,
  rentFrequency,
  propertyTimezone,
  now,
  emptyMessage = 'No charges fall in this window.',
  truncatedCount,
}: LeaseScheduleSummaryProps) {
  const [showAll, setShowAll] = useState(false);

  if (periods.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const groups = groupScheduleByAmount(periods);
  const totalCents = scheduleTotalCents(periods);
  // Nothing to disclose when the summary already lists every period individually
  // (no run collapsed) — showing a toggle that reveals an identical list is noise.
  const hasCollapsedRows = groups.some((group) => group.periods.length > 1);

  return (
    <div className="space-y-3">
      <dl className="divide-y rounded-md border text-sm">
        {groups.map((group, index) => (
          <div
            key={group.periods[0]!.generationKey}
            className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          >
            <dt className="shrink-0 font-medium text-muted-foreground sm:w-28">
              {labelForGroup(index, groups.length, group)}
            </dt>
            <dd className="sm:text-right">
              {describeGroup(group, { currency, calendar, rentFrequency })}
            </dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between px-4 py-3 font-medium">
          <dt>Total over the term</dt>
          <dd>{formatMoney(totalCents, currency)}</dd>
        </div>
      </dl>

      {!!truncatedCount && truncatedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {truncatedCount} further {truncatedCount === 1 ? 'period is' : 'periods are'} not shown here.
        </p>
      )}

      {hasCollapsedRows && (
        <Collapsible open={showAll} onOpenChange={setShowAll}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-1.5">
              <ChevronDown
                aria-hidden="true"
                className={`h-4 w-4 transition-transform ${showAll ? 'rotate-180' : ''}`}
              />
              {showAll ? 'Hide every period' : `Show every period (${periods.length})`}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3">
            <LeaseScheduleTable
              periods={periods}
              currency={currency}
              calendar={calendar}
              propertyTimezone={propertyTimezone}
              now={now}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/**
 * The text to the right of a group's label. Formatting only — picks fields off
 * the group's periods (`periods.length`, `periods[0]`) and runs them through
 * `formatCivilDate` / `formatMoney`, never arithmetic on a date or an amount.
 *
 * A collapsed run (more than one period) states only the amount and cadence —
 * e.g. "onwards ₹5,000.00 monthly" — never the period count or date span. Both
 * are derivable from the lease term already on screen.
 */
function describeGroup(
  group: ScheduleGroup,
  opts: { currency: Currency; calendar: CalendarSystem; rentFrequency: RentFrequency },
): string {
  const { periods } = group;
  const { currency, calendar, rentFrequency } = opts;

  if (periods.length === 1) {
    const period = periods[0]!;
    const span =
      period.periodStart === period.periodEnd
        ? formatCivilDate(period.periodStart, calendar)
        : `${formatCivilDate(period.periodStart, calendar)} – ${formatCivilDate(period.periodEnd, calendar)}`;

    const parts = [span, `due ${formatCivilDate(period.dueDate, calendar)}`, formatMoney(period.amountCents, currency)];
    if (period.isProrated) {
      parts.push(`prorated, ${period.daysOccupied} of ${period.daysInPeriod} days`);
    }
    return parts.join(' · ');
  }

  // Deliberately NOT the period count or the date span — both are derivable from
  // the lease term already on screen, and spelling them out here just reintroduces
  // the noise collapsing the run was meant to remove. The amount and cadence are
  // the only facts this line owns; everything else lives in the full table behind
  // the disclosure.
  const first = periods[0]!;
  const frequencyWord = rentFrequencyLabels[rentFrequency].toLowerCase();
  return `onwards ${formatMoney(first.amountCents, currency)} ${frequencyWord}`;
}
