import { toast } from 'sonner';
import type { Property } from '@rms/contract';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { errorMessage } from '@/lib/form-errors';
import { useDeleteProperty } from './api';

interface DeletePropertyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: Property;
  /** Called after a successful delete, e.g. to navigate away from the detail page. */
  onDeleted?: () => void;
}

export function DeletePropertyDialog({
  open,
  onOpenChange,
  property,
  onDeleted,
}: DeletePropertyDialogProps) {
  const deleteMutation = useDeleteProperty();

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      itemKind="property"
      itemName={property.name}
      consequence={
        property.unitCount > 0
          ? `Its ${property.unitCount} unit${property.unitCount === 1 ? '' : 's'} will be deleted too.`
          : undefined
      }
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        deleteMutation.mutate(property.id, {
          onSuccess: () => {
            toast.success('Property deleted');
            onOpenChange(false);
            onDeleted?.();
          },
          onError: (error) => toast.error(errorMessage(error)),
        });
      }}
    />
  );
}
