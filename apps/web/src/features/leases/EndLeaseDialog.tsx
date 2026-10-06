import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  endReason,
  endReasonLabels,
  statusForEndReason,
  leaseStatusLabels,
  type EndReason,
  type LeaseDetail,
} from '@rms/contract';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CivilDateInput } from '@/components/civil-date-input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/form-errors';
import { useEndLease } from './api';
import { LeaseScheduleTable } from './LeaseScheduleTable';
import { previewSchedule, type PreviewLeaseInput } from './schedule-preview';
import { moveOutBillingCopy } from './frequency-copy';

const endReasons = endReason.options;

interface EndLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
}

/**
 * Recomputes the schedule preview LIVE as the landlord types a move-out date, so
 * the final charge is on screen before they commit (docs/PLAN-PHASE2.md §8.2 item
 * 7, Amendment A.5). The move-out copy is driven by the lease's own
 * `moveOutBillingPolicy` (read live from its property) — never hardcoded.
 */
export function EndLeaseDialog({ open, onOpenChange, lease }: EndLeaseDialogProps) {
  const [endDate, setEndDate] = useState(lease.endDate ?? lease.startDate);
  const [moveOutDate, setMoveOutDate] = useState(lease.moveOutDate ?? '');
  const [reason, setReason] = useState<EndReason>('term_ended');
  const [note, setNote] = useState('');
  const mutation = useEndLease(lease.id);

  const resultingStatus = statusForEndReason(reason);

  const periods = useMemo(() => {
    if (!endDate) return [];
    const leaseInput: PreviewLeaseInput = {
      rentFrequency: lease.rentFrequency,
      rentCents: lease.rentCents,
      billingDay: lease.billingDay,
      startDate: lease.startDate,
      endDate,
      ledgerStartDate: lease.ledgerStartDate,
      moveOutDate: moveOutDate || null,
      moveOutBillingPolicy: lease.moveOutBillingPolicy,
      calendar: lease.calendar,
    };
    try {
      return previewSchedule(leaseInput, endDate);
    } catch {
      return [];
    }
  }, [
    endDate,
    moveOutDate,
    lease.rentFrequency,
    lease.rentCents,
    lease.billingDay,
    lease.startDate,
    lease.ledgerStartDate,
    lease.moveOutBillingPolicy,
    lease.calendar,
  ]);

  const finalPeriod = periods.at(-1);

  function handleSubmit() {
    mutation.mutate(
      {
        endDate,
        moveOutDate: moveOutDate || undefined,
        reason,
        note: note.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(`Lease marked ${leaseStatusLabels[resultingStatus].toLowerCase()}`);
          onOpenChange(false);
        },
        // The backend writes these messages for the landlord to read — surface the
        // 409 verbatim, never re-worded client-side.
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>End lease</DialogTitle>
          <DialogDescription>
            This will mark the lease <strong className="text-foreground">{leaseStatusLabels[resultingStatus]}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="end-lease-endDate">End date</Label>
              <CivilDateInput
                id="end-lease-endDate"
                label="End date"
                calendar={lease.calendar}
                value={endDate}
                onChange={setEndDate}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="end-lease-moveOutDate">Move-out date (optional)</Label>
              <CivilDateInput
                id="end-lease-moveOutDate"
                label="Move-out date"
                calendar={lease.calendar}
                value={moveOutDate}
                onChange={setMoveOutDate}
                optional
              />
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            {moveOutBillingCopy(lease.moveOutBillingPolicy, endDate || null, lease.calendar)}
          </p>

          <div className="grid gap-1.5">
            <Label htmlFor="end-lease-reason">Reason</Label>
            <Select value={reason} onValueChange={(value) => setReason(value as EndReason)}>
              <SelectTrigger id="end-lease-reason" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {endReasons.map((r) => (
                  <SelectItem key={r} value={r}>
                    {endReasonLabels[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="end-lease-note">Note (optional)</Label>
            <Textarea id="end-lease-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div>
            <h3 className="text-sm font-medium">Final schedule</h3>
            {finalPeriod && (
              <p className="mt-1 text-sm text-muted-foreground">
                The final charge is on screen before you commit — nothing here is a surprise.
              </p>
            )}
            <div className="mt-2">
              <LeaseScheduleTable
                periods={periods}
                currency={lease.currency}
                calendar={lease.calendar}
                emptyMessage="Pick an end date to preview the final charge."
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={mutation.isPending || !endDate}>
            {mutation.isPending ? 'Ending…' : 'End lease'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
