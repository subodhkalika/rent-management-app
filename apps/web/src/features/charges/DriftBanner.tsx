import { useMemo } from 'react';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  billingTermsFor,
  chargesDueForGeneration,
  diffChargesAgainstSchedule,
  localToday,
  formatMoney,
  type ChargeDrift,
  type LeaseDetail,
} from '@rms/contract';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCivilDate } from '@/lib/format-civil-date';
import { errorMessage } from '@/lib/form-errors';
import { useAllGeneratedRentCharges, useGenerateCharges } from './api';

interface DriftBannerProps {
  lease: LeaseDetail;
  /** Opens the correct dialog for this written charge — the `amount` / `due_date` action. */
  onReviewCharge: (chargeId: string) => void;
  /** Opens the void dialog for this written charge — the `unscheduled` action. */
  onVoidCharge: (chargeId: string) => void;
}

/**
 * The drift banner — the ONLY thing that makes a rent-step correction (or a
 * billing-day change, or an end-date move) visible once charges already exist.
 * The generator never rewrites a row that already exists, so without this a
 * correction looks like it silently did nothing (docs/PLAN-PHASE3A.md §3.6).
 *
 * The comparison is `diffChargesAgainstSchedule`, the one function both this app
 * and the API assert against the same fixtures — never a second implementation.
 * `planned` is computed exactly as the generator computes it
 * (`chargesDueForGeneration`, the property's own `today`), so "missing" only ever
 * means "the generator would have written this by now and has not" — never a
 * period that is not due for weeks.
 */
export function DriftBanner({ lease, onReviewCharge, onVoidCharge }: DriftBannerProps) {
  const { charges, isPending, isError, error, refetch } = useAllGeneratedRentCharges(lease.id);
  const generateMutation = useGenerateCharges(lease.id);

  const drifts = useMemo(() => {
    if (!charges) return null;
    const today = localToday(lease.propertyTimezone);
    const terms = billingTermsFor(lease);
    const planned = chargesDueForGeneration(terms, today);
    return diffChargesAgainstSchedule({ charges, planned });
  }, [charges, lease]);

  if (isPending) {
    return <Skeleton className="h-16 w-full" aria-label="Checking for charges that need review" />;
  }

  if (isError) {
    return (
      <Alert variant="destructive" role="alert" aria-live="polite">
        <AlertTriangle />
        <AlertTitle>Couldn't check for charges that need review</AlertTitle>
        <AlertDescription>
          <p>{error?.message ?? 'Something went wrong.'}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!drifts || drifts.length === 0) return null;

  const needsReview = drifts.filter((d) => d.kind === 'amount' || d.kind === 'due_date');
  const missing = drifts.filter((d) => d.kind === 'missing');
  const unscheduled = drifts.filter((d) => d.kind === 'unscheduled');

  function handleGenerate() {
    generateMutation.mutate(undefined, {
      onSuccess: ({ created }) => {
        toast.success(created.length > 0 ? `${created.length} charge(s) generated` : 'Nothing new to generate');
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  }

  return (
    <Alert className="border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950" role="alert" aria-live="polite">
      <AlertTriangle className="text-amber-600" />
      <AlertTitle>Charges need review</AlertTitle>
      <AlertDescription className="w-full">
        {needsReview.length > 0 && (
          <div className="mt-1 w-full">
            <p>
              <strong className="text-foreground">{needsReview.length}</strong> written{' '}
              {needsReview.length === 1 ? 'charge was' : 'charges were'} billed under terms that have since
              changed. Each row's own number stays frozen until you review and supersede it.
            </p>
            <ul className="mt-1 space-y-1">
              {needsReview.map((d) => (
                <DriftRow key={d.generationKey} drift={d} lease={lease}>
                  <Button size="sm" variant="outline" onClick={() => d.chargeId && onReviewCharge(d.chargeId)}>
                    Review
                  </Button>
                </DriftRow>
              ))}
            </ul>
          </div>
        )}

        {missing.length > 0 && (
          <div className="mt-3 w-full">
            <p>
              <strong className="text-foreground">{missing.length}</strong> scheduled{' '}
              {missing.length === 1 ? 'period has' : 'periods have'} no charge yet.
            </p>
            <ul className="mt-1 space-y-1">
              {missing.map((d) => (
                <DriftRow key={d.generationKey} drift={d} lease={lease} />
              ))}
            </ul>
            <Button size="sm" className="mt-2" onClick={handleGenerate} disabled={generateMutation.isPending}>
              {generateMutation.isPending ? 'Generating…' : 'Run generation'}
            </Button>
          </div>
        )}

        {unscheduled.length > 0 && (
          <div className="mt-3 w-full">
            <p>
              <strong className="text-foreground">{unscheduled.length}</strong> written{' '}
              {unscheduled.length === 1 ? 'charge no longer matches' : 'charges no longer match'} the schedule —
              typically a lease ended after this period was already written.
            </p>
            <ul className="mt-1 space-y-1">
              {unscheduled.map((d) => (
                <DriftRow key={d.generationKey} drift={d} lease={lease}>
                  <Button size="sm" variant="outline" onClick={() => d.chargeId && onVoidCharge(d.chargeId)}>
                    Void it
                  </Button>
                </DriftRow>
              ))}
            </ul>
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

function DriftRow({
  drift,
  lease,
  children,
}: {
  drift: ChargeDrift;
  lease: LeaseDetail;
  children?: React.ReactNode;
}) {
  const shown = drift.actual ?? drift.expected;
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-background/60 px-2 py-1 text-xs dark:border-amber-900">
      <span>
        {formatCivilDate(drift.generationKey, lease.calendar)}
        {shown && (
          <>
            {' · '}
            {formatMoney(shown.amountCents, lease.currency)}
            {' · due '}
            {formatCivilDate(shown.dueDate, lease.calendar)}
          </>
        )}
        {drift.kind === 'amount' && drift.actual && drift.expected && (
          <span className="text-muted-foreground"> (now {formatMoney(drift.expected.amountCents, lease.currency)})</span>
        )}
        {drift.kind === 'due_date' && drift.actual && drift.expected && (
          <span className="text-muted-foreground">
            {' '}
            (now due {formatCivilDate(drift.expected.dueDate, lease.calendar)})
          </span>
        )}
      </span>
      {children}
    </li>
  );
}
