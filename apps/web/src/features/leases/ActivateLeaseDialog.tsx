import { toast } from 'sonner';
import type { LeaseDetail } from '@rms/contract';
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
import { useActivateLease } from './api';

interface ActivateLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
}

export function ActivateLeaseDialog({ open, onOpenChange, lease }: ActivateLeaseDialogProps) {
  const mutation = useActivateLease(lease.id);

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
