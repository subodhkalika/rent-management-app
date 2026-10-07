import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import {
  localToday,
  validateBillingTerms,
  billingTermsFromCreateBody,
  type Unit,
  type DraftRentStep,
} from '@rms/contract';
import { Button } from '@/components/ui/button';
import { useProperty } from '@/features/properties/api';
import { applyServerErrors, blankToUndefined, errorMessage } from '@/lib/form-errors';
import { useCreateLease } from '../api';
import { UnitStep } from './UnitStep';
import { TenantsStep } from './TenantsStep';
import { TermsStep } from './TermsStep';
import { ReviewStep } from './ReviewStep';
import { WizardStepper } from './WizardStepper';
import { createLeaseBody, type CreateLeaseBody, type WizardInput } from './types';

const STEPS = ['Unit', 'Tenants', 'Terms', 'Review'] as const;
type Step = (typeof STEPS)[number];

function emptyValues(): WizardInput {
  return {
    unitId: '',
    tenantIds: [],
    primaryTenantId: '',
    startDate: '',
    endDate: undefined,
    rentCents: 0,
    rentFrequency: 'monthly',
    billingDay: 1,
    depositCents: 0,
    ledgerStartDate: undefined,
    openingBalanceCents: 0,
    notes: '',
    escalation: null,
    rentSteps: [],
  };
}

/** The create wizard: unit -> tenants -> terms -> review. `POST /v1/leases` always
 *  creates a `draft` (docs/PLAN-PHASE2.md §0 decision 10) — activating is a
 *  separate, explicit step from the lease detail page. */
export function CreateLeasePage() {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedUnit, setSelectedUnit] = useState<Unit | undefined>(undefined);
  // Lifted above `TermsStep` (rather than local state there) because that step
  // unmounts when the wizard moves to another step, and a landlord's manual
  // overrides — plus the `clauseExpectedCents` that drives the "agreed" column —
  // must survive stepping back and forth across the wizard.
  const [draftSteps, setDraftSteps] = useState<DraftRentStep[]>([]);
  const propertyQuery = useProperty(selectedUnit?.propertyId ?? '');
  const property = propertyQuery.data;

  const form = useForm<WizardInput, unknown, CreateLeaseBody>({
    resolver: zodResolver(createLeaseBody),
    defaultValues: emptyValues(),
  });

  const createMutation = useCreateLease();
  const step: Step = STEPS[stepIndex] ?? 'Unit';

  // Defaults the start date to "today" the moment the unit's property resolves —
  // in the PROPERTY's own timezone (§1.8), never the browser's. Only fires once:
  // it backs off the instant the field has a value, whether from this effect, a
  // typed edit, or a form reset.
  useEffect(() => {
    if (property && !form.getValues('startDate')) {
      form.setValue('startDate', localToday(property.timezone));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property]);

  const fieldsByStep: Record<Step, (keyof WizardInput)[]> = {
    Unit: ['unitId'],
    Tenants: ['tenantIds', 'primaryTenantId'],
    Terms: [
      'startDate',
      'endDate',
      'rentCents',
      'rentFrequency',
      'billingDay',
      'depositCents',
      'ledgerStartDate',
      'openingBalanceCents',
    ],
    Review: [],
  };

  async function goNext() {
    const valid = await form.trigger(fieldsByStep[step]);
    if (!valid) return;

    // `createLeaseBody`'s own superRefine only checks calendar-INDEPENDENT rules
    // now (a request schema can't see which property, and therefore which
    // calendar, a lease belongs to — see the contract's own note on
    // `createLeaseBody`). The wizard DOES know the calendar by this step, so it
    // calls `validateBillingTerms` directly via the exported
    // `billingTermsFromCreateBody` adapter — the one sanctioned way to build
    // those terms — rather than let an invalid `ledgerStartDate` surface only as
    // a server 422 after submit (docs/PLAN-PHASE2.md §8.2 item 5).
    if (step === 'Terms' && property) {
      const values = form.getValues();
      // `billingDay` carries a zod `.default(1)`, so the form's INPUT type allows
      // it to be momentarily `undefined`; `billingTermsFromCreateBody` wants the
      // resolved value, same fallback the schema itself would apply.
      const terms = billingTermsFromCreateBody(
        { ...values, billingDay: values.billingDay ?? 1 },
        property.calendar,
      );
      const error = validateBillingTerms(terms);
      if (error) {
        form.setError('ledgerStartDate', { type: 'validate', message: error });
        return;
      }
    }

    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  function goBack() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  const onSubmit = form.handleSubmit((values) => {
    const payload: CreateLeaseBody = {
      ...values,
      notes: blankToUndefined(values.notes),
      endDate: values.endDate ?? undefined,
      ledgerStartDate: values.ledgerStartDate ?? undefined,
    };
    createMutation.mutate(payload, {
      onSuccess: (created) => {
        toast.success('Draft lease created');
        navigate(`/leases/${created.id}`);
      },
      onError: (error) => {
        const applied = applyServerErrors(error, form.setError);
        if (!applied) toast.error(errorMessage(error));
      },
    });
  });

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link
        to="/leases"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" /> All leases
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight">New lease</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Always saved as a draft first — review the schedule before activating it.
      </p>

      <WizardStepper steps={STEPS} currentIndex={stepIndex} />

      <div className="mt-6">
        {step === 'Unit' && (
          <UnitStep
            form={form}
            onUnitSelected={(unit) => {
              setSelectedUnit(unit);
              if (!form.getValues('rentCents')) {
                form.setValue('rentCents', unit.marketRentCents);
              }
            }}
          />
        )}
        {step === 'Tenants' && <TenantsStep form={form} />}
        {step === 'Terms' && (
          <TermsStep
            form={form}
            property={property}
            unit={selectedUnit}
            draftSteps={draftSteps}
            onDraftStepsChange={setDraftSteps}
          />
        )}
        {step === 'Review' && <ReviewStep form={form} propertyQuery={propertyQuery} unit={selectedUnit} />}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <Button type="button" variant="outline" onClick={goBack} disabled={stepIndex === 0}>
          Back
        </Button>
        {step === 'Review' ? (
          <Button type="button" onClick={() => void onSubmit()} disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating…' : 'Create draft lease'}
          </Button>
        ) : (
          <Button type="button" onClick={() => void goNext()}>
            Next
          </Button>
        )}
      </div>
    </main>
  );
}
