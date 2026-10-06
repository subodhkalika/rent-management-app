import { useMemo } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import {
  formatMoney,
  rentFrequencyLabels,
  tenantFullName,
  type Property,
  type Unit,
  type PlannedCharge,
} from '@rms/contract';
import type { ApiClientError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTenants } from '@/features/tenants/api';
import { formatCivilDate } from '@/lib/format-civil-date';
import { previewFirstPeriod, type PreviewLeaseInput } from '../schedule-preview';
import { moveOutBillingCopy } from '../frequency-copy';
import type { WizardForm } from './types';

interface ReviewStepProps {
  form: WizardForm;
  unit?: Unit;
  /** The selected unit's property — its calendar and move-out policy decide what
   *  this preview even means, so the step must know whether it has actually
   *  resolved, not just whatever value happens to be sitting in cache. */
  propertyQuery: UseQueryResult<Property, ApiClientError>;
}

/**
 * Step 4. Shows the lease's summary and the one number a tenant actually queries:
 * the first charge, in full when it is prorated (the unusual amount), or stated
 * plainly when it is not. Computed with a single-period call — see
 * `previewFirstPeriod` — never the full term's schedule.
 */
export function ReviewStep({ form, unit, propertyQuery }: ReviewStepProps) {
  const values = form.watch();
  const tenantsQuery = useTenants();
  const tenants = tenantsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const selectedTenants = tenants.filter((t) => values.tenantIds?.includes(t.id));
  const primaryTenant = tenants.find((t) => t.id === values.primaryTenantId);
  const currency = unit?.currency ?? 'USD';
  const property = propertyQuery.data;

  // Hooks stay unconditional (Rules of Hooks) — the loading/error branches below
  // only decide what JSX this returns, never whether this memo runs.
  const { firstPeriod, previewError } = useMemo((): {
    firstPeriod: PlannedCharge | undefined;
    previewError: string | null;
  } => {
    if (!property || !values.startDate || !values.rentFrequency) {
      return { firstPeriod: undefined, previewError: null };
    }
    const leaseInput: PreviewLeaseInput = {
      rentFrequency: values.rentFrequency,
      rentCents: values.rentCents ?? 0,
      billingDay: values.billingDay ?? 1,
      startDate: values.startDate,
      endDate: values.endDate ?? null,
      ledgerStartDate: values.ledgerStartDate ?? values.startDate,
      moveOutDate: null,
      moveOutBillingPolicy: property.moveOutBillingPolicy,
      calendar: property.calendar,
    };
    try {
      return { firstPeriod: previewFirstPeriod(leaseInput), previewError: null };
    } catch (error) {
      return {
        firstPeriod: undefined,
        previewError: error instanceof Error ? error.message : 'Could not compute a preview.',
      };
    }
    // `values` is a plain snapshot from `form.watch()`, re-read every render —
    // depending on the individual fields keeps this from re-running once per
    // keystroke across unrelated steps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    property,
    values.startDate,
    values.endDate,
    values.rentFrequency,
    values.rentCents,
    values.billingDay,
    values.ledgerStartDate,
  ]);

  // A missing preview is honest; a confidently wrong one is not. Defaulting the
  // calendar to Gregorian and the policy to `bill_full_term` while the property
  // query was still loading (or had failed) previously meant a Bikram Sambat
  // landlord could review a schedule computed in the wrong calendar entirely —
  // never flagged as wrong, never matching what they'd actually be billed.
  if (propertyQuery.isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-40 w-full" aria-label="Loading this unit's property" />
        <p className="text-sm text-muted-foreground">
          Loading this unit's property — the preview needs its calendar and billing policy.
        </p>
      </div>
    );
  }

  if (propertyQuery.isError || !property) {
    return (
      <div
        role="alert"
        aria-live="polite"
        className="rounded-md border border-destructive/30 bg-destructive/5 p-4"
      >
        <p className="text-sm font-medium">Couldn't load this unit's property</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The schedule preview needs the property's calendar and move-out billing policy to be
          accurate, so it can't be shown without them.
          {propertyQuery.error && ` ${propertyQuery.error.message}`}
        </p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void propertyQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const calendar = property.calendar;
  const policy = property.moveOutBillingPolicy;

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

      <section className="rounded-md border p-4">
        <h2 className="text-sm font-medium">First charge</h2>
        <div className="mt-2">
          {previewError ? (
            <p role="alert" className="text-sm text-destructive">
              {previewError}
            </p>
          ) : !firstPeriod ? (
            <p className="text-sm text-muted-foreground">
              Fill in the start date and rent to see the first charge.
            </p>
          ) : firstPeriod.isProrated ? (
            <div className="space-y-1 text-sm">
              <p>
                {formatCivilDate(firstPeriod.occupiedStart, calendar)} –{' '}
                {formatCivilDate(firstPeriod.occupiedEnd, calendar)}
                <Badge variant="outline" className="ml-2">
                  Prorated
                </Badge>
              </p>
              <p>
                Due {formatCivilDate(firstPeriod.dueDate, calendar)} ·{' '}
                {formatMoney(firstPeriod.amountCents, currency)}
              </p>
              <p className="text-muted-foreground">
                {firstPeriod.daysOccupied} of {firstPeriod.daysInPeriod} days
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {formatMoney(values.rentCents ?? 0, currency)} /{' '}
              {rentFrequencyLabels[values.rentFrequency].toLowerCase()}, starting{' '}
              {formatCivilDate(firstPeriod.periodStart, calendar)}, due{' '}
              {formatCivilDate(firstPeriod.dueDate, calendar)}.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
