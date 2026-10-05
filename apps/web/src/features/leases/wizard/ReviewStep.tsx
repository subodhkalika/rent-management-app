import { useMemo } from 'react';
import {
  formatMoney,
  rentFrequencyLabels,
  tenantFullName,
  type Property,
  type Unit,
  type PlannedCharge,
} from '@rms/contract';
import { useTenants } from '@/features/tenants/api';
import { formatCivilDate } from '@/lib/format-civil-date';
import { LeaseScheduleTable } from '../LeaseScheduleTable';
import { previewSchedule, defaultPreviewThrough, type PreviewLeaseInput } from '../schedule-preview';
import { moveOutBillingCopy } from '../frequency-copy';
import type { WizardForm } from './types';

interface ReviewStepProps {
  form: WizardForm;
  property?: Property;
  unit?: Unit;
}

const PREVIEW_ROW_CAP = 36;

/**
 * Step 4 — THE screen this phase exists for (docs/PLAN-PHASE2.md). A live schedule
 * preview computed client-side by `buildSchedule`, not fetched, so the landlord
 * sees the actual charges this lease will generate before committing to it.
 */
export function ReviewStep({ form, property, unit }: ReviewStepProps) {
  const values = form.watch();
  const tenantsQuery = useTenants();
  const tenants = tenantsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const selectedTenants = tenants.filter((t) => values.tenantIds?.includes(t.id));
  const primaryTenant = tenants.find((t) => t.id === values.primaryTenantId);
  const currency = unit?.currency ?? 'USD';
  const calendar = property?.calendar ?? 'gregorian';
  const policy = property?.moveOutBillingPolicy ?? 'bill_full_term';

  const { periods, truncated, previewError } = useMemo((): {
    periods: PlannedCharge[];
    truncated: number;
    previewError: string | null;
  } => {
    if (!values.startDate || !values.rentFrequency) {
      return { periods: [], truncated: 0, previewError: null };
    }
    const leaseInput: PreviewLeaseInput = {
      rentFrequency: values.rentFrequency,
      rentCents: values.rentCents ?? 0,
      billingDay: values.billingDay ?? 1,
      startDate: values.startDate,
      endDate: values.endDate ?? null,
      ledgerStartDate: values.ledgerStartDate ?? values.startDate,
      moveOutDate: null,
      moveOutBillingPolicy: policy,
      calendar,
    };
    try {
      const through = defaultPreviewThrough(values.startDate, values.endDate ?? null);
      const full = previewSchedule(leaseInput, through);
      return {
        periods: full.slice(0, PREVIEW_ROW_CAP),
        truncated: Math.max(0, full.length - PREVIEW_ROW_CAP),
        previewError: null,
      };
    } catch (error) {
      return {
        periods: [],
        truncated: 0,
        previewError: error instanceof Error ? error.message : 'Could not compute a preview.',
      };
    }
    // `values` is a plain snapshot from `form.watch()`, re-read every render —
    // depending on the individual fields keeps this from re-running once per
    // keystroke across unrelated steps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    values.startDate,
    values.endDate,
    values.rentFrequency,
    values.rentCents,
    values.billingDay,
    values.ledgerStartDate,
    policy,
    calendar,
  ]);

  return (
    <div className="space-y-6">
      <section className="rounded-md border p-4">
        <h2 className="text-sm font-medium">Summary</h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <dt className="text-muted-foreground">Unit</dt>
          <dd>{unit?.label ?? '—'}</dd>
          <dt className="text-muted-foreground">Tenants</dt>
          <dd>
            {selectedTenants.length > 0
              ? selectedTenants.map((t) => tenantFullName(t)).join(', ')
              : '—'}
            {primaryTenant && (
              <span className="text-muted-foreground"> · primary: {tenantFullName(primaryTenant)}</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Rent</dt>
          <dd>
            {formatMoney(values.rentCents ?? 0, currency)} /{' '}
            {rentFrequencyLabels[values.rentFrequency].toLowerCase()}
          </dd>
          <dt className="text-muted-foreground">Term</dt>
          <dd>
            {values.startDate ? formatCivilDate(values.startDate, calendar) : '—'} –{' '}
            {values.endDate ? formatCivilDate(values.endDate, calendar) : 'rolling'}
          </dd>
          <dt className="text-muted-foreground">Deposit</dt>
          <dd>{formatMoney(values.depositCents ?? 0, currency)}</dd>
          {values.ledgerStartDate && (
            <>
              <dt className="text-muted-foreground">Ledger starts</dt>
              <dd>{formatCivilDate(values.ledgerStartDate, calendar)}</dd>
            </>
          )}
          {!!values.openingBalanceCents && (
            <>
              <dt className="text-muted-foreground">Opening balance</dt>
              <dd>{formatMoney(values.openingBalanceCents, currency)}</dd>
            </>
          )}
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          {moveOutBillingCopy(policy, values.endDate ?? null, calendar)}
        </p>
      </section>

      <section>
        <h2 className="text-sm font-medium">Schedule preview</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Computed from the same rules the server bills with — this is what the tenant will
          actually be charged, not an estimate.
        </p>
        <div className="mt-3">
          {previewError ? (
            <p role="alert" className="text-sm text-destructive">
              {previewError}
            </p>
          ) : (
            <LeaseScheduleTable
              periods={periods}
              currency={currency}
              calendar={calendar}
              truncatedCount={truncated}
              emptyMessage="Fill in the start date and rent to see the schedule."
            />
          )}
        </div>
      </section>
    </div>
  );
}
