import { useMemo } from 'react';
import { toast } from 'sonner';
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
} from '@/components/ui/alert-dialog';
import { errorMessage } from '@/lib/form-errors';
import { previewActivationCharges } from '@/features/charges/generation-preview';
import { useActivateLease } from './api';

interface ActivateLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
}

/**
 * The onboarding guard-rail (docs/PLAN-PHASE3A.md §8): activating a tenancy that
 * started months ago writes every rent period back to `ledgerStartDate` in one
 * synchronous pass, several of them already overdue. That is correct and intended
 * — the alarming part is finding out AFTER committing, so the count and total are
 * shown here, computed the same way the generator computes them.
 */
export function ActivateLeaseDialog({ open, onOpenChange, lease }: ActivateLeaseDialogProps) {
  const mutation = useActivateLease(lease.id);

  const preview = useMemo(() => {
    if (!open) return null;
    try {
      return previewActivationCharges(lease);
    } catch {
      // A schedule that cannot be previewed (an out-of-range Bikram Sambat date, an
      // implausibly long term) still activates — the server is the authority on
      // whether it can generate; this preview is a courtesy, not a gate.
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lease]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Activate this lease?</AlertDialogTitle>
          <AlertDialogDescription>
            This marks {lease.unitLabel} as occupied and starts its billing schedule.
            Requires at least one tenant with exactly one marked primary, and the unit to
            have no other active lease.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-md border p-3 text-sm" aria-live="polite">
          {preview === null ? null : preview === undefined ? (
            <p className="text-muted-foreground">Couldn't preview the charges this will create.</p>
          ) : preview.items.length === 0 ? (
            <p className="text-muted-foreground">
              Activating writes no charges yet — nothing falls within the schedule's lookahead.
            </p>
          ) : (
            <p>
              Activating creates <strong className="text-foreground">{preview.items.length}</strong>{' '}
              {preview.items.length === 1 ? 'charge' : 'charges'} totalling{' '}
              <strong className="text-foreground">{formatMoney(preview.totalCents, lease.currency)}</strong>
              {preview.overdueCount > 0 ? (
                <>
                  ; <strong className="text-destructive">{preview.overdueCount}</strong>{' '}
                  {preview.overdueCount === 1 ? 'is' : 'are'} already overdue.
                </>
              ) : (
                '.'
              )}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate(undefined, {
                onSuccess: () => {
                  toast.success('Lease activated');
                  onOpenChange(false);
                },
                // Surfaced verbatim — the backend writes these for the landlord to read.
                onError: (error) => toast.error(errorMessage(error)),
              });
            }}
          >
            {mutation.isPending ? 'Activating…' : 'Activate'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
