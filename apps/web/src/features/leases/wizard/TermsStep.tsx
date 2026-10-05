import { useState } from 'react';
import { rentFrequency, rentFrequencyLabels, type Property, type Unit } from '@rms/contract';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { RentInput } from '@/features/units/RentInput';
import { frequencyBillingDayHelp, showsBillingDay } from '../frequency-copy';
import type { WizardForm } from './types';

const frequencies = rentFrequency.options;

interface TermsStepProps {
  form: WizardForm;
  property?: Property;
  unit?: Unit;
}

/** Step 3: the terms. This is where §8.2 item 4 (the frequency toggle) and item 5
 *  (the "existing tenancy" disclosure) live. */
export function TermsStep({ form, property, unit }: TermsStepProps) {
  const [showExistingTenancy, setShowExistingTenancy] = useState(
    () => !!(form.getValues('ledgerStartDate') || form.getValues('openingBalanceCents')),
  );
  const frequency = form.watch('rentFrequency');
  const errors = form.formState.errors;
  const currency = unit?.currency;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="wizard-rentCents">Rent{currency ? ` (${currency})` : ''}</Label>
          <RentInput
            id="wizard-rentCents"
            value={form.watch('rentCents') ?? 0}
            onChange={(cents) => form.setValue('rentCents', cents, { shouldValidate: true })}
            aria-invalid={!!errors.rentCents}
          />
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
            max={31}
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
          <Input
            id="wizard-startDate"
            type="date"
            value={form.watch('startDate') ?? ''}
            onChange={(e) => form.setValue('startDate', e.target.value, { shouldValidate: true })}
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
          <Input
            id="wizard-endDate"
            type="date"
            value={form.watch('endDate') ?? ''}
            onChange={(e) => form.setValue('endDate', e.target.value === '' ? null : e.target.value, { shouldValidate: true })}
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
              <Input
                id="wizard-ledgerStartDate"
                type="date"
                value={form.watch('ledgerStartDate') ?? ''}
                onChange={(e) =>
                  form.setValue('ledgerStartDate', e.target.value === '' ? undefined : e.target.value, {
                    shouldValidate: true,
                  })
                }
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
