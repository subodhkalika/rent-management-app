import { useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock } from 'lucide-react';
import { formatMoney, type LeaseDetail } from '@rms/contract';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { formatCivilDate } from '@/lib/format-civil-date';
import { errorMessage } from '@/lib/form-errors';
import { previewNextPeriodCharge } from './next-period-preview';
import { useAllGeneratedRentCharges, useGenerateNextPeriodCharge } from './api';

interface GenerateNextPeriodActionProps {
  lease: LeaseDetail;
}

/**
 * The deliberate "bill one period early" action: a tenant turns up wanting to pay
 * the next period's rent before the scheduled run would create it. Charges
 * ordinarily appear on their own, on the first day of the period they cover — this
 * is the exception a landlord reaches for on purpose, so it sits as a quiet,
 * secondary control next to the charges list rather than competing with the
 * lease's own actions or the regular "Generate charges" run.
 *
 * The preview is computed client-side from the same engine the server calls
 * (`chargesThroughNextPeriod`) rather than asked of the server, exactly like
 * `ActivateLeaseDialog` previews activation. If the next period already has a
 * charge — voided or not — the action is disabled rather than left to click
 * through and write nothing.
 */
export function GenerateNextPeriodAction({ lease }: GenerateNextPeriodActionProps) {
  const [open, setOpen] = useState(false);
  const { charges, isPending: chargesPending } = useAllGeneratedRentCharges(lease.id);
  const mutation = useGenerateNextPeriodCharge(lease.id);

  const preview = charges ? previewNextPeriodCharge(lease, charges) : null;

  // Nothing beyond what's already due to reach into — the lease's own schedule
  // ends before a "next period" exists. There is nothing this action could ever
  // write, so it does not appear at all.
  if (!chargesPending && preview === null) return null;

  const disabled = chargesPending || !preview || preview.alreadyGenerated;

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={disabled}
          title={preview?.alreadyGenerated ? 'Already billed for that period' : undefined}
        >
          <CalendarClock /> Bill next period early
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Bill the next period early?</AlertDialogTitle>
          <AlertDialogDescription>
            Charges normally appear on their own, on the first day of the period they cover. Use this when a
            tenant wants to pay ahead of that — for example, before the next period has started.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border p-3 text-sm" aria-live="polite">
          {preview && !preview.alreadyGenerated ? (
            <p>
              This creates one rent charge for{' '}
              <strong className="text-foreground">
                {formatCivilDate(preview.periodStart, lease.calendar)} –{' '}
                {formatCivilDate(preview.periodEnd, lease.calendar)}
              </strong>
              , due {formatCivilDate(preview.dueDate, lease.calendar)}, for{' '}
              <strong className="text-foreground">{formatMoney(preview.amountCents, lease.currency)}</strong>.
            </p>
          ) : (
            <p className="text-muted-foreground">
              A charge for that period already exists — there's nothing left to bill early.
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending || disabled}
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate(undefined, {
                onSuccess: ({ created }) => {
                  toast.success(created.length > 0 ? 'Next period billed' : 'Nothing new to bill');
                  setOpen(false);
                },
                onError: (error) => toast.error(errorMessage(error)),
              });
            }}
          >
            {mutation.isPending ? 'Billing…' : 'Bill it'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
