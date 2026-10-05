import { toast } from 'sonner';
import type { LeaseDetail } from '@rms/contract';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { errorMessage } from '@/lib/form-errors';
import { useDeleteLease } from './api';

interface DeleteLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
  onDeleted?: () => void;
}

/** Only ever legal on `draft` / `cancelled` — a lease that has ever been active is
 *  kept for the record (the backend's own `409` message says so verbatim). */
export function DeleteLeaseDialog({ open, onOpenChange, lease, onDeleted }: DeleteLeaseDialogProps) {
  const mutation = useDeleteLease();

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      itemKind="lease"
      itemName={`${lease.unitLabel} (${lease.propertyName})`}
      isPending={mutation.isPending}
      onConfirm={() => {
        mutation.mutate(lease.id, {
          onSuccess: () => {
            toast.success('Lease deleted');
            onOpenChange(false);
            onDeleted?.();
          },
          onError: (error) => toast.error(errorMessage(error)),
        });
      }}
    />
  );
}
