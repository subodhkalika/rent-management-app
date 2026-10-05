import { useState } from 'react';
import { toast } from 'sonner';
import type { LeaseDetail } from '@rms/contract';
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
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/form-errors';
import { useCancelLease } from './api';

interface CancelLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
}

/** Only ever legal on a `draft` — the lease detail page gates when this is
 *  reachable, and the backend's own `409` is the authority either way. */
export function CancelLeaseDialog({ open, onOpenChange, lease }: CancelLeaseDialogProps) {
  const [reason, setReason] = useState('');
  const mutation = useCancelLease(lease.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this draft?</DialogTitle>
          <DialogDescription>
            {lease.unitLabel} will be marked cancelled. It stays visible for the record and
            can be deleted afterwards.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="cancel-lease-reason">Reason (optional)</Label>
          <Textarea id="cancel-lease-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Keep draft
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { reason: reason.trim() || undefined },
                {
                  onSuccess: () => {
                    toast.success('Lease cancelled');
                    onOpenChange(false);
                  },
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            {mutation.isPending ? 'Cancelling…' : 'Cancel lease'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
