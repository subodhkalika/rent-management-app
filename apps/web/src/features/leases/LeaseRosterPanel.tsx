import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Star, UserMinus } from 'lucide-react';
import type { LeaseDetail } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { errorMessage } from '@/lib/form-errors';
import { useRemoveLeaseTenant, useSetPrimaryTenant } from './api';
import { AddLeaseTenantDialog } from './AddLeaseTenantDialog';

/** Roster add / remove / set-primary (docs/PLAN-PHASE2.md §8.2 item 6). A removed
 *  tenant stays listed, read-only, with their departure date — §5.6: everyone on
 *  a lease was jointly liable for the whole term, so there is nothing here they
 *  did not already have access to. */
export function LeaseRosterPanel({ lease }: { lease: LeaseDetail }) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Roster</h2>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus /> Add tenant
        </Button>
      </div>

      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Added</TableHead>
            <TableHead>Removed</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lease.tenants.map((t) => (
            <TableRow key={t.tenantId}>
              <TableCell className="font-medium">
                {t.firstName} {t.lastName}
                {t.isPrimary && (
                  <Badge variant="outline" className="ml-2">
                    Primary
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatCivilDate(t.addedOn, lease.calendar)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {t.removedOn ? formatCivilDate(t.removedOn, lease.calendar) : '—'}
              </TableCell>
              <TableCell>
                {!t.removedOn && (
                  <div className="flex justify-end gap-1">
                    {!t.isPrimary && <SetPrimaryButton lease={lease} tenantId={t.tenantId} />}
                    <RemoveTenantButton lease={lease} tenantId={t.tenantId} isPrimary={t.isPrimary} />
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AddLeaseTenantDialog open={addOpen} onOpenChange={setAddOpen} lease={lease} />
    </div>
  );
}

function SetPrimaryButton({ lease, tenantId }: { lease: LeaseDetail; tenantId: string }) {
  const mutation = useSetPrimaryTenant(lease.id, tenantId);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Make primary"
      disabled={mutation.isPending}
      onClick={() =>
        mutation.mutate(undefined, {
          onSuccess: () => toast.success('Primary tenant updated'),
          onError: (error) => toast.error(errorMessage(error)),
        })
      }
    >
      <Star />
    </Button>
  );
}

function RemoveTenantButton({
  lease,
  tenantId,
  isPrimary,
}: {
  lease: LeaseDetail;
  tenantId: string;
  isPrimary: boolean;
}) {
  const mutation = useRemoveLeaseTenant(lease.id, tenantId);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Remove from lease"
      disabled={mutation.isPending}
      title={isPrimary ? 'Reassign the primary tenant before removing them' : undefined}
      onClick={() =>
        mutation.mutate(
          {},
          {
            onSuccess: () => toast.success('Tenant removed from lease'),
            // Covers both 409s named in §5.5: removing the primary without
            // reassigning first, and removing the last live tenant from an active
            // lease — both come back as the backend's own message, shown verbatim.
            onError: (error) => toast.error(errorMessage(error)),
          },
        )
      }
    >
      <UserMinus />
    </Button>
  );
}
