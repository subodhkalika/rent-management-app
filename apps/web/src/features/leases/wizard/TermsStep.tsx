import { useState } from 'react';
import {
  rentFrequency,
  rentFrequencyLabels,
  MAX_BILLING_DAY,
  MAX_BILLING_DAY_ANY,
  compareIsoDate,
  localToday,
  formatMoney,
  type CalendarSystem,
  type DraftRentStep,
  type RentEscalation,
  type Property,
  type Unit,
} from '@rms/contract';
import { CivilDateInput } from '@/components/civil-date-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { RentInput } from '@/features/units/RentInput';
import { frequencyBillingDayHelp, showsBillingDay } from '../frequency-copy';
import { currentRentCents, toRentStepInput } from '../rent-ladder';
import { RentLadderPanel } from './RentLadderPanel';
import type { WizardForm } from './types';

const frequencies = rentFrequency.options;

interface TermsStepProps {
  form: WizardForm;
  property?: Property;
  unit?: Unit;
  /** The live draft ladder — lifted to `CreateLeasePage` rather than held locally
   *  here, because this step unmounts when the wizard moves to another step and a
   *  landlord's manual overrides (and the `clauseExpectedCents` that drives the
   *  "agreed" column) must survive stepping back and forth. */
  draftSteps: DraftRentStep[];
  onDraftStepsChange: (steps: DraftRentStep[]) => void;
}

/** Step 3: the terms. This is where §8.2 item 4 (the frequency toggle), item 5
 *  (the "existing tenancy" disclosure) and the rent-ladder panel (escalation plan
 *  §6.2) live. */
export function TermsStep({ form, property, unit, draftSteps, onDraftStepsChange }: TermsStepProps) {
  const [showExistingTenancy, setShowExistingTenancy] = useState(
    () => !!(form.getValues('ledgerStartDate') || form.getValues('openingBalanceCents')),
  );
  const frequency = form.watch('rentFrequency');
  const errors = form.formState.errors;
  const currency = unit?.currency;
  // The property may not have resolved yet (the unit was just picked); fall back
  // to the widest ceiling any calendar allows rather than hardcoding Gregorian's
  // 31 — a Bikram Sambat month reaches 32 (`MAX_BILLING_DAY`), and the server
  // validates the real per-calendar bound regardless of what this attribute says.
  const maxBillingDay = property ? MAX_BILLING_DAY[property.calendar] : MAX_BILLING_DAY_ANY;
  // The property may not have resolved yet — same fallback as above. A fresh
  // wizard with no property picked yet has nothing to be wrong about; once the
  // property loads, this re-renders with its real calendar.
  const calendar: CalendarSystem = property?.calendar ?? 'gregorian';

  const rentCents = form.watch('rentCents') ?? 0;
  const startDate = form.watch('startDate');
  const clause = form.watch('escalation') ?? null;

  function handleClauseChange(next: RentEscalation | null) {
    form.setValue('escalation', next, { shouldValidate: true });
  }

  function handleStepsChange(next: DraftRentStep[]) {
    onDraftStepsChange(next);
    form.setValue('rentSteps', toRentStepInput(next), { shouldValidate: true });
  }

  // The in-flight onboarding trap (escalation plan §6.3): `rentCents` means the
  // rent AT LEASE START, not today. Onboarding a tenancy whose start date is
  // already in the past, with a ladder on screen, is exactly the moment a
  // landlord is likeliest to type today's rent by habit and silently re-price the
  // whole term. Relabel the field and show the real "today" figure the instant
  // both a start date and a drafted ladder exist.
  const today = property ? localToday(property.timezone) : null;
  const startedInPast = !!(today && startDate && compareIsoDate(startDate, today) < 0);
  const showOnboardingTrapNotice = startedInPast && draftSteps.length > 0;
  const rentToday = showOnboardingTrapNotice ? currentRentCents(rentCents, draftSteps, today!) : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="wizard-rentCents">
            {showOnboardingTrapNotice ? 'Rent at lease start' : 'Rent'}
            {currency ? ` (${currency})` : ''}
          </Label>
          <RentInput
            id="wizard-rentCents"
            value={form.watch('rentCents') ?? 0}
            onChange={(cents) => form.setValue('rentCents', cents, { shouldValidate: true })}
            aria-invalid={!!errors.rentCents}
            aria-describedby={showOnboardingTrapNotice ? 'wizard-rentCents-today' : undefined}
          />
          {showOnboardingTrapNotice && rentToday !== null && (
            <p id="wizard-rentCents-today" className="text-sm text-muted-foreground">
              Rent today, from the ladder below: <strong>{formatMoney(rentToday, currency ?? 'USD')}</strong>
            </p>
          )}
          {errors.rentCents && (
            <p role="alert" className="text-sm text-destructive">
              {errors.rentCents.message}
            </p>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="wizard-depositCents">Deposit{currency ? ` (${currency})` : ''}</Label>
          <RentInput
            id="wizard-depositCents"
            value={form.watch('depositCents') ?? 0}
            onChange={(cents) => form.setValue('depositCents', cents, { shouldValidate: true })}
            aria-invalid={!!errors.depositCents}
          />
          {errors.depositCents && (
            <p role="alert" className="text-sm text-destructive">
              {errors.depositCents.message}
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-1.5">
        <span className="text-sm font-medium" id="wizard-frequency-label">
          Frequency
        </span>
        <RadioGroup
          aria-labelledby="wizard-frequency-label"
          value={frequency}
          onValueChange={(value) =>
            form.setValue('rentFrequency', value as (typeof frequencies)[number], { shouldValidate: true })
          }
          className="grid grid-cols-2 gap-2"
        >
          {frequencies.map((option) => (
            <label
              key={option}
              htmlFor={`wizard-frequency-${option}`}
              className="flex items-center gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary"
            >
              <RadioGroupItem value={option} id={`wizard-frequency-${option}`} />
              {rentFrequencyLabels[option]}
            </label>
          ))}
        </RadioGroup>
        <p className="text-sm text-muted-foreground">{frequencyBillingDayHelp[frequency]}</p>
      </div>

      {showsBillingDay(frequency) && (
        <div className="grid gap-1.5 sm:w-48">
          <Label htmlFor="wizard-billingDay">Billing day</Label>
          <Input
            id="wizard-billingDay"
            type="number"
            min={1}
            max={maxBillingDay}
            step={1}
            value={form.watch('billingDay') ?? 1}
            onChange={(e) => form.setValue('billingDay', e.target.valueAsNumber, { shouldValidate: true })}
            aria-invalid={!!errors.billingDay}
          />
          {errors.billingDay && (
            <p role="alert" className="text-sm text-destructive">
              {errors.billingDay.message}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="wizard-startDate">Start date</Label>
          <CivilDateInput
            id="wizard-startDate"
            label="Start date"
            calendar={calendar}
            value={form.watch('startDate') ?? ''}
            onChange={(value) => form.setValue('startDate', value, { shouldValidate: true })}
            aria-invalid={!!errors.startDate}
          />
          {errors.startDate && (
            <p role="alert" className="text-sm text-destructive">
              {errors.startDate.message}
            </p>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="wizard-endDate">End date</Label>
          <CivilDateInput
            id="wizard-endDate"
            label="End date"
            calendar={calendar}
            value={form.watch('endDate') ?? ''}
            onChange={(value) => form.setValue('endDate', value === '' ? null : value, { shouldValidate: true })}
            optional
            aria-invalid={!!errors.endDate}
            aria-describedby="wizard-endDate-help"
          />
          <p id="wizard-endDate-help" className="text-sm text-muted-foreground">
            Leave blank for a rolling, open-ended lease.
          </p>
          {errors.endDate && (
            <p role="alert" className="text-sm text-destructive">
              {errors.endDate.message}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="wizard-existing-tenancy">Existing tenancy</Label>
            <p className="text-sm text-muted-foreground">
              Onboarding a tenant who's already living here? Set what they already owe and
              from when the ledger should start, instead of billing the whole term from day
              one.
            </p>
          </div>
          <Switch
            id="wizard-existing-tenancy"
            checked={showExistingTenancy}
            onCheckedChange={(checked) => {
              setShowExistingTenancy(checked);
              if (!checked) {
                form.setValue('ledgerStartDate', undefined);
                form.setValue('openingBalanceCents', 0);
              }
            }}
          />
        </div>

        {showExistingTenancy && (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="wizard-ledgerStartDate">Ledger start date</Label>
              <CivilDateInput
                id="wizard-ledgerStartDate"
                label="Ledger start date"
                calendar={calendar}
                value={form.watch('ledgerStartDate') ?? ''}
                onChange={(value) =>
                  form.setValue('ledgerStartDate', value === '' ? undefined : value, {
                    shouldValidate: true,
                  })
                }
                optional
                aria-invalid={!!errors.ledgerStartDate}
                aria-describedby="wizard-ledgerStartDate-help"
              />
              <p id="wizard-ledgerStartDate-help" className="text-sm text-muted-foreground">
                Must be the start date itself, or the first day of a billing period for this
                lease's cadence — charges before this date become the opening balance
                instead of individual periods.
              </p>
              {errors.ledgerStartDate && (
                <p role="alert" className="text-sm text-destructive">
                  {errors.ledgerStartDate.message}
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="wizard-openingBalanceCents">Opening balance{currency ? ` (${currency})` : ''}</Label>
              <RentInput
                id="wizard-openingBalanceCents"
                value={form.watch('openingBalanceCents') ?? 0}
                onChange={(cents) => form.setValue('openingBalanceCents', cents, { shouldValidate: true })}
                aria-invalid={!!errors.openingBalanceCents}
              />
              {errors.openingBalanceCents && (
                <p role="alert" className="text-sm text-destructive">
                  {errors.openingBalanceCents.message}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {startDate && (
        <RentLadderPanel
          currency={currency ?? 'USD'}
          calendar={calendar}
          baseRentCents={rentCents}
          startDate={startDate}
          endDate={form.watch('endDate') ?? null}
          frequency={frequency}
          clause={clause}
          steps={draftSteps}
          onClauseChange={handleClauseChange}
          onStepsChange={handleStepsChange}
        />
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="wizard-notes">Notes (optional, landlord-private)</Label>
        <Textarea
          id="wizard-notes"
          rows={3}
          value={form.watch('notes') ?? ''}
          onChange={(e) => form.setValue('notes', e.target.value)}
        />
      </div>
    </div>
  );
}
