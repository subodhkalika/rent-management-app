import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  generateRentSteps,
  type RentEscalation,
  type RentFrequency,
  type CalendarSystem,
  type DraftRentStep,
  type IsoDate,
  type Currency,
} from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { RentEscalationClauseFields } from '../RentEscalationClauseFields';
import { RentLadderEditor } from '../RentLadderEditor';
import { CascadeDiffDialog } from '../CascadeDiffDialog';
import { mergeDraftWithManualOverrides, toRentStepInput } from '../rent-ladder';

interface RentLadderPanelProps {
  currency: Currency;
  calendar: CalendarSystem;
  baseRentCents: number;
  startDate: IsoDate;
  endDate: IsoDate | null;
  frequency: RentFrequency;
  clause: RentEscalation | null;
  steps: DraftRentStep[];
  onClauseChange: (clause: RentEscalation | null) => void;
  onStepsChange: (steps: DraftRentStep[]) => void;
}

/**
 * The lease form's rent-ladder panel (escalation plan §6.2): the clause, the live
 * ladder it drafts, and the cascade-diff confirmation for any row the landlord
 * overrides. Closed by default so a single-rate lease looks exactly as it did
 * before this feature existed.
 *
 * `clause`/`steps` are owned by the parent (the wizard's form state, via
 * `TermsStep`) so they are submitted as `escalation`/`rentSteps` on
 * `POST /v1/leases`, and so the parent can also show the "Rent at lease start" /
 * "Rent today" relabel next to the base rent field itself (escalation plan §6.3)
 * — this component only ever proposes a new ladder; the landlord's own edits are
 * what gets kept.
 */
export function RentLadderPanel({
  currency,
  calendar,
  baseRentCents,
  startDate,
  endDate,
  frequency,
  clause,
  steps,
  onClauseChange,
  onStepsChange,
}: RentLadderPanelProps) {
  const [open, setOpen] = useState(clause !== null);
  const [pendingEdit, setPendingEdit] = useState<{ index: number; newRentCents: number } | null>(null);

  // Draft (or re-draft) the ladder the moment the clause, the base rent, the start
  // date or the cadence exist — escalation plan §6.2 item 2 / the typo defence
  // (§6.2 item 5): the figures appear the instant the rate is entered, not after a
  // save. Any step the landlord already set by hand is preserved by date — see
  // `mergeDraftWithManualOverrides`.
  useEffect(() => {
    if (!clause || !startDate) {
      if (steps.length > 0) onStepsChange([]);
      return;
    }
    const fresh = generateRentSteps({ clause, baseRentCents, startDate, endDate, frequency, calendar });
    const merged = mergeDraftWithManualOverrides(fresh, steps);
    const changed =
      merged.length !== steps.length ||
      merged.some(
        (s, i) =>
          s.effectiveFrom !== steps[i]?.effectiveFrom ||
          s.rentCents !== steps[i]?.rentCents ||
          s.source !== steps[i]?.source,
      );
    if (changed) onStepsChange(merged);
    // `steps` is deliberately excluded — this effect's own job is to RE-derive
    // `steps` from the clause/base/dates, so depending on it would self-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clause, baseRentCents, startDate, endDate, frequency, calendar]);

  function handleEditStep(index: number, newRentCents: number) {
    setPendingEdit({ index, newRentCents });
  }

  function handleResetStep(index: number) {
    const step = steps[index];
    if (!step || step.clauseExpectedCents === null) return;
    const resetValue = step.clauseExpectedCents;
    onStepsChange(steps.map((s, i) => (i === index ? { ...s, rentCents: resetValue, source: 'clause' } : s)));
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border p-3">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="flex w-full items-center justify-between px-0">
          <span className="text-sm font-medium">Rent increases over the term (optional)</span>
          <ChevronDown className={open ? 'rotate-180 transition-transform' : 'transition-transform'} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent className="mt-4 space-y-4">
        <RentEscalationClauseFields idPrefix="wizard-escalation" value={clause} onChange={onClauseChange} />

        {clause && startDate && (
          <RentLadderEditor
            currency={currency}
            calendar={calendar}
            baseRentCents={baseRentCents}
            startDate={startDate}
            steps={steps}
            onEditStep={handleEditStep}
            onResetStep={handleResetStep}
          />
        )}
      </CollapsibleContent>

      <CascadeDiffDialog
        open={pendingEdit !== null}
        onOpenChange={(next) => {
          if (!next) setPendingEdit(null);
        }}
        clause={clause}
        steps={steps}
        index={pendingEdit?.index ?? null}
        newRentCents={pendingEdit?.newRentCents ?? null}
        currency={currency}
        calendar={calendar}
        onConfirm={(next) => {
          onStepsChange(next);
          setPendingEdit(null);
        }}
      />
    </Collapsible>
  );
}

/** Converts the panel's draft ladder to the wire shape for `createLeaseBody.rentSteps`. */
export { toRentStepInput };
