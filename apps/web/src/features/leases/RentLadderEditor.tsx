import { useState } from 'react';
import { Pencil, RotateCcw } from 'lucide-react';
import { formatMoney, type Currency, type CalendarSystem, type DraftRentStep, type IsoDate } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { RentInput } from '@/features/units/RentInput';
import { hasTakenEffect, variancePercent } from './rent-ladder';

export interface RentLadderEditorProps {
  currency: Currency;
  calendar: CalendarSystem;
  baseRentCents: number;
  startDate: IsoDate;
  /** Ascending, the increases only — the base above is row zero, bound to
   *  `baseRentCents` directly, never a member of this array (escalation plan §2.2:
   *  the base is a column, the increases are rows). */
  steps: readonly DraftRentStep[];
  /** When supplied, a step at or before this date is already in force and is
   *  rendered read-only with a "Correct" action instead of "Edit"/"Reset" — the
   *  line the escalation plan draws between a draft and money already owed
   *  (§4.5). Omitted entirely on the create wizard, where nothing has happened yet
   *  and every row edits freely. */
  today?: IsoDate;
  onEditStep?: (index: number, newRentCents: number) => void;
  onResetStep?: (index: number) => void;
  onCorrectStep?: (index: number) => void;
  readOnly?: boolean;
}

/**
 * The editable ladder — base as row zero, then each increase with its date, its
 * rent, and (when it was overridden) what the clause would have said beside it.
 * This table IS the 100%-instead-of-10%-typo defence (escalation plan §6.2 item 5
 * / §5): the moment a rate is entered, `generateRentSteps` runs and this renders
 * the drafted figures, so a landlord who meant 10% and typed 100 sees the wrong
 * number in row one before they ever reach a save button.
 */
export function RentLadderEditor({
  currency,
  calendar,
  baseRentCents,
  startDate,
  steps,
  today,
  onEditStep,
  onResetStep,
  onCorrectStep,
  readOnly = false,
}: RentLadderEditorProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draftCents, setDraftCents] = useState(0);

  function startEdit(index: number, currentCents: number) {
    setEditingIndex(index);
    setDraftCents(currentCents);
  }

  function commitEdit(index: number) {
    if (Number.isFinite(draftCents) && draftCents >= 0) {
      onEditStep?.(index, draftCents);
    }
    setEditingIndex(null);
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Effective from</TableHead>
            <TableHead>Rent</TableHead>
            <TableHead>Agreed</TableHead>
            {!readOnly && <TableHead className="text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>{formatCivilDate(startDate, calendar)}</TableCell>
            <TableCell className="font-medium">{formatMoney(baseRentCents, currency)}</TableCell>
            <TableCell>
              <Badge variant="outline">Base</Badge>
            </TableCell>
            {!readOnly && <TableCell />}
          </TableRow>

          {steps.map((step, index) => {
            const inForce = today !== undefined && hasTakenEffect(step.effectiveFrom, today);
            const variance = variancePercent(step.clauseExpectedCents, step.rentCents);
            const isEditing = editingIndex === index;

            return (
              <TableRow key={step.effectiveFrom}>
                <TableCell>{formatCivilDate(step.effectiveFrom, calendar)}</TableCell>
                <TableCell className="font-medium">
                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`rent-step-${index}`} className="sr-only">
                        Rent from {formatCivilDate(step.effectiveFrom, calendar)}
                      </Label>
                      <RentInput id={`rent-step-${index}`} value={draftCents} onChange={setDraftCents} />
                    </div>
                  ) : (
                    formatMoney(step.rentCents, currency)
                  )}
                </TableCell>
                <TableCell>
                  <AgreedCell step={step} variance={variance} currency={currency} />
                </TableCell>
                {!readOnly && (
                  <TableCell className="text-right">
                    {isEditing ? (
                      <div className="flex justify-end gap-1">
                        <Button type="button" size="sm" onClick={() => commitEdit(index)}>
                          Save
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setEditingIndex(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : inForce ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onCorrectStep?.(index)}
                      >
                        Correct
                      </Button>
                    ) : (
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label={`Edit the rent effective ${formatCivilDate(step.effectiveFrom, calendar)}`}
                          onClick={() => startEdit(index, step.rentCents)}
                        >
                          <Pencil /> Edit
                        </Button>
                        {step.source === 'manual' && step.clauseExpectedCents !== null && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Reset the rent effective ${formatCivilDate(step.effectiveFrom, calendar)} to the agreed figure`}
                            onClick={() => onResetStep?.(index)}
                          >
                            <RotateCcw /> Reset
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function AgreedCell({
  step,
  variance,
  currency,
}: {
  step: DraftRentStep;
  variance: number | null;
  currency: Currency;
}) {
  if (step.source === 'clause') {
    return <span className="text-sm text-muted-foreground">Clause</span>;
  }
  if (step.clauseExpectedCents === null) {
    return <span className="text-sm text-muted-foreground">Manual</span>;
  }
  if (variance === null) {
    return <span className="text-sm text-muted-foreground">Matches the clause</span>;
  }
  const direction = variance < 0 ? 'down' : 'up';
  return (
    <span className="text-sm text-muted-foreground">
      Agreed {formatMoney(step.clauseExpectedCents, currency)}
      {' · '}
      <span className={direction === 'down' ? 'text-amber-600' : 'text-foreground'}>
        {variance > 0 ? '+' : ''}
        {variance.toFixed(1)}%
      </span>
    </span>
  );
}
