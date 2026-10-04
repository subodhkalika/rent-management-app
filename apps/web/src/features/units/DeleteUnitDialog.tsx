import { toast } from 'sonner';
import type { Unit } from '@rms/contract';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { errorMessage } from '@/lib/form-errors';
import { useDeleteUnit } from './api';

interface DeleteUnitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  propertyId: string;
  unit: Unit;
}

export function DeleteUnitDialog({ open, onOpenChange, propertyId, unit }: DeleteUnitDialogProps) {
  const deleteMutation = useDeleteUnit(propertyId);

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      itemKind="unit"
      itemName={unit.label}
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        deleteMutation.mutate(unit.id, {
          onSuccess: () => {
            toast.success('Unit deleted');
            onOpenChange(false);
          },
          onError: (error) => toast.error(errorMessage(error)),
        });
      }}
    />
  );
}
