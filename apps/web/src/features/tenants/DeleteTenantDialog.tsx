import { toast } from 'sonner';
import { tenantFullName, type Tenant } from '@rms/contract';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { errorMessage } from '@/lib/form-errors';
import { useDeleteTenant } from './api';

interface DeleteTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: Tenant;
  /** Called after a successful delete, e.g. to navigate away from the detail page. */
  onDeleted?: () => void;
}

export function DeleteTenantDialog({
  open,
  onOpenChange,
  tenant,
  onDeleted,
}: DeleteTenantDialogProps) {
  const deleteMutation = useDeleteTenant();

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      itemKind="tenant"
      itemName={tenantFullName(tenant)}
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        deleteMutation.mutate(tenant.id, {
          onSuccess: () => {
            toast.success('Tenant deleted');
            onOpenChange(false);
            onDeleted?.();
          },
          onError: (error) => toast.error(errorMessage(error)),
        });
      }}
    />
  );
}
