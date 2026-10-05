import { useState } from 'react';
import { toast } from 'sonner';
import { tenantFullName, type LeaseDetail } from '@rms/contract';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useTenants } from '@/features/tenants/api';
import { errorMessage } from '@/lib/form-errors';
import { useAddLeaseTenant } from './api';

interface AddLeaseTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
}

export function AddLeaseTenantDialog({ open, onOpenChange, lease }: AddLeaseTenantDialogProps) {
  const [tenantId, setTenantId] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const mutation = useAddLeaseTenant(lease.id);
  const tenantsQuery = useTenants();
  const tenants = tenantsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const currentTenantIds = new Set(lease.tenants.filter((t) => !t.removedOn).map((t) => t.tenantId));
  const eligible = tenants.filter((t) => !currentTenantIds.has(t.id));

  function reset() {
    setTenantId('');
    setIsPrimary(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a tenant</DialogTitle>
          <DialogDescription>Adds someone to this lease's roster — a roommate move-in.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="add-tenant-select">Tenant</Label>
            {eligible.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Every tenant you have is already on this lease.
              </p>
            ) : (
              <Select value={tenantId} onValueChange={setTenantId}>
                <SelectTrigger id="add-tenant-select" className="w-full">
                  <SelectValue placeholder="Select a tenant" />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {tenantFullName(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="add-tenant-primary">Make primary</Label>
              <p className="text-sm text-muted-foreground">Who reminders address.</p>
            </div>
            <Switch id="add-tenant-primary" checked={isPrimary} onCheckedChange={setIsPrimary} />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending || !tenantId}
            onClick={() =>
              mutation.mutate(
                { tenantId, isPrimary },
                {
                  onSuccess: () => {
                    toast.success('Tenant added');
                    reset();
                    onOpenChange(false);
                  },
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            {mutation.isPending ? 'Adding…' : 'Add tenant'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
