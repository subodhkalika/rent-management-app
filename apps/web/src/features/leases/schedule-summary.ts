import type { PlannedCharge } from '@rms/contract';

/**
 * A run of one or more consecutive `PlannedCharge`s that collapse to one line in
 * `LeaseScheduleSummary`. Pure grouping device — every period inside came straight
 * out of `buildSchedule`; nothing here ever recomputes a date or an amount.
 *
 * `periods.length === 1` renders as a fully-detailed row (a prorated period, a
 * standalone period sitting between two differently-priced runs, or the entire
 * schedule when it is exactly one period). `periods.length > 1` renders as a
 * collapsed summary: amount, count, span.
 */
export interface ScheduleGroup {
  periods: readonly PlannedCharge[];
}

/**
 * Collapses consecutive periods that share an `amountCents` into one group. A
 * prorated period never joins a group — including with another prorated period —
 * so every prorated period always renders in full, which is the entire point: a
 * landlord or tenant checks those, never the repeated middle.
 *
 * Grouping is by EQUAL AMOUNT, not by position. Today a lease realistically looks
 * like [prorated-first, long equal run, prorated-last], but nothing here assumes
 * that shape — a rent change mid-term that produces two different-amount runs, or
 * a standalone one-off period, collapses and expands correctly too.
 *
 * Never derives, recomputes or adjusts a date or an amount. Each period is copied
 * into a group exactly as `buildSchedule` produced it.
 */
export function groupScheduleByAmount(periods: readonly PlannedCharge[]): ScheduleGroup[] {
  const groups: { periods: PlannedCharge[] }[] = [];

  for (const period of periods) {
    const current = groups.at(-1);
    const canJoin =
      current !== undefined &&
      !period.isProrated &&
      !current.periods[0]!.isProrated &&
      current.periods[0]!.amountCents === period.amountCents;

    if (canJoin) {
      current!.periods.push(period);
    } else {
      groups.push({ periods: [period] });
    }
  }

  return groups;
}

/**
 * Sum of every period's amount — the "Total over the term" figure. Always summed
 * from the FULL schedule, never from the collapsed groups, so a bug in the
 * grouping above can never hide inside the number a landlord reads.
 */
export function scheduleTotalCents(periods: readonly PlannedCharge[]): number {
  return periods.reduce((sum, period) => sum + period.amountCents, 0);
}

/**
 * The label that introduces a group's line — "First period", "Then", "Final
 * period", and so on. Purely positional/structural: it never looks at a date or an
 * amount beyond what `groupScheduleByAmount` already decided.
 *
 * A schedule that collapses to one group (every period the same amount, or a
 * single-period lease) gets a neutral label, never "Then" dangling with nothing
 * before it — that is the "reads cleanly" case the single-rate lease needs.
 */
export function labelForGroup(index: number, totalGroups: number, group: ScheduleGroup): string {
  if (totalGroups === 1) return 'Rent';

  const isProratedGroup = group.periods[0]!.isProrated;
  if (isProratedGroup) {
    if (index === 0) return 'First period';
    if (index === totalGroups - 1) return 'Final period';
    return 'Prorated period';
  }

  return index === 0 ? 'Rent' : 'Then';
}
