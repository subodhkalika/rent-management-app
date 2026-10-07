import { useMemo, useState } from 'react';
import {
  recomputeLadderFrom,
  formatMoney,
  type Currency,
  type CalendarSystem,
  type RentEscalation,
  type DraftRentStep,
} from '@rms/contract';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { formatCivilDate } from '@/lib/format-civil-date';

interface CascadeDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clause: RentEscalation | null;
  /** The ladder BEFORE this edit. */
  steps: readonly DraftRentStep[];
  /** The step being changed, or `null` when the dialog has nothing to show (also
   *  used to gate rendering so hooks below always run on a consistent shape). */
  index: number | null;
  newRentCents: number | null;
  currency: Currency;
  calendar: CalendarSystem;
  onConfirm: (nextSteps: DraftRentStep[]) => void;
}

/**
 * The single most important interaction in the whole feature (escalation plan §4.4
 * / R2 decision 5): before anything is written, show exactly what changes — the
 * step itself, every LATER `clause` step that recomputes from it, and every LATER
 * `manual` step that is left alone, with the toggle to skip the cascade entirely.
 * `recomputeLadderFrom` is pure and runs here, client-side, so the diff on screen
 * is bitwise the ladder that gets stored — nothing is ever recomputed without the
 * landlord having seen this first.
 */
export function CascadeDiffDialog({
  open,
  onOpenChange,
  clause,
  steps,
  index,
  newRentCents,
  currency,
  calendar,
  onConfirm,
}: CascadeDiffDialogProps) {
  const [cascade, setCascade] = useState(true);

  const target = index !== null ? steps[index] : undefined;

  const cascaded = useMemo(() => {
    if (index === null || newRentCents === null || target === undefined) return null;
    return recomputeLadderFrom({ clause, steps, index, newRentCents });
  }, [clause, steps, index, newRentCents, target]);

  const isolated = useMemo(() => {
    if (index === null || newRentCents === null || target === undefined) return null;
    return steps.map((s, i): DraftRentStep => (i === index ? { ...s, rentCents: newRentCents, source: 'manual' } : s));
  }, [steps, index, newRentCents, target]);

  if (target === undefined || cascaded === null || isolated === null || index === null || newRentCents === null) {
    return null;
  }

  const result = cascade ? cascaded : isolated;

  const recomputedLater = result
    .map((s, i) => ({ before: steps[i]!, after: s, i }))
    .filter(({ i, before, after }) => i > index && after.rentCents !== before.rentCents);

  const unchangedLater = result
    .map((s, i) => ({ after: s, i }))
    .filter(({ i }) => i > index)
    .filter(({ i, after }) => !recomputedLater.some((r) => r.i === i) && after.source === 'manual');

  function handleApply() {
    onConfirm(result);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Change this rent step</DialogTitle>
          <DialogDescription>
            Review what this changes before it's applied — nothing is recomputed until you confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p>
            Change {formatCivilDate(target.effectiveFrom, calendar)} from{' '}
            <strong className="text-foreground">{formatMoney(target.rentCents, currency)}</strong> to{' '}
            <strong className="text-foreground">{formatMoney(newRentCents, currency)}</strong>
          </p>

          {cascade && recomputedLater.length > 0 && (
            <div>
              <p className="text-muted-foreground">
                This also updates, because the agreement carries forward from the new figure:
              </p>
              <ul className="mt-1 space-y-1 pl-4">
                {recomputedLater.map(({ before, after }) => (
                  <li key={before.effectiveFrom}>
                    {formatCivilDate(before.effectiveFrom, calendar)} {formatMoney(before.rentCents, currency)}{' '}
                    &rarr; {formatMoney(after.rentCents, currency)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {cascade && unchangedLater.length > 0 && (
            <div>
              <p className="text-muted-foreground">Unchanged, because you set it by hand:</p>
              <ul className="mt-1 space-y-1 pl-4">
                {unchangedLater.map(({ after }) => (
                  <li key={after.effectiveFrom}>
                    {formatCivilDate(after.effectiveFrom, calendar)} {formatMoney(after.rentCents, currency)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!cascade && steps.length > index + 1 && (
            <p className="text-muted-foreground">
              Only this step changes. Every later step stays exactly as it is.
            </p>
          )}

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="cascade-toggle">Also update later years</Label>
              <p className="text-muted-foreground">
                Off changes only this one step and leaves the rest of the ladder alone.
              </p>
            </div>
            <Switch id="cascade-toggle" checked={cascade} onCheckedChange={setCascade} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleApply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
