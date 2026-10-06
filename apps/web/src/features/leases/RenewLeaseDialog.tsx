import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { rentFrequency, rentFrequencyLabels, type LeaseDetail, type RentFrequency } from '@rms/contract';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RentInput } from '@/features/units/RentInput';
import { errorMessage } from '@/lib/form-errors';
import { useRenewLease } from './api';
import { frequencyBillingDayHelp, showsBillingDay } from './frequency-copy';

const frequencies = rentFrequency.options;

interface RenewLeaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
}

/**
 * `rentFrequency` is immutable on an active lease (docs/PLAN-PHASE2.md §1.9) —
 * supplying a different one here is the supported way to change cadence, which is
 * why this is a renewal dialog and not a PATCH.
 */
export function RenewLeaseDialog({ open, onOpenChange, lease }: RenewLeaseDialogProps) {
  const navigate = useNavigate();
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rentCents, setRentCents] = useState(lease.rentCents);
  const [frequency, setFrequency] = useState<RentFrequency>(lease.rentFrequency);
  const [billingDay, setBillingDay] = useState(lease.billingDay);
  const [depositCents, setDepositCents] = useState(lease.depositCents);
  const mutation = useRenewLease(lease.id);

  const cadenceChanged = frequency !== lease.rentFrequency;

  function handleSubmit() {
    mutation.mutate(
      {
        startDate,
        endDate: endDate || undefined,
        rentCents,
        rentFrequency: frequency,
        billingDay: showsBillingDay(frequency) ? billingDay : undefined,
        depositCents,
      },
      {
        onSuccess: (created) => {
          toast.success('Lease renewed');
          onOpenChange(false);
          navigate(`/leases/${created.id}`);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Renew lease</DialogTitle>
          <DialogDescription>
            Creates a new lease for {lease.unitLabel}, carrying over the current roster. The
            new start date must be after{' '}
            {lease.status === 'active' ? "this lease's start date" : 'this lease ended'} — an
            overlapping term is rejected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="renew-startDate">New start date</Label>
              <CivilDateInput
                id="renew-startDate"
                label="New start date"
                calendar={lease.calendar}
                value={startDate}
                onChange={setStartDate}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="renew-endDate">End date (optional)</Label>
              <CivilDateInput
                id="renew-endDate"
                label="End date"
                calendar={lease.calendar}
                value={endDate}
                onChange={setEndDate}
                optional
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="renew-rentCents">Rent ({lease.currency})</Label>
              <RentInput id="renew-rentCents" value={rentCents} onChange={setRentCents} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="renew-depositCents">Deposit ({lease.currency})</Label>
              <RentInput id="renew-depositCents" value={depositCents} onChange={setDepositCents} />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="renew-frequency">Frequency</Label>
            <Select value={frequency} onValueChange={(value) => setFrequency(value as RentFrequency)}>
              <SelectTrigger id="renew-frequency" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {frequencies.map((option) => (
                  <SelectItem key={option} value={option}>
                    {rentFrequencyLabels[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{frequencyBillingDayHelp[frequency]}</p>
            {cadenceChanged && (
              <p className="text-sm text-muted-foreground">
                This changes the billing cadence for the new lease. The predecessor's existing
                charges are unaffected.
              </p>
            )}
          </div>

          {showsBillingDay(frequency) && (
            <div className="grid gap-1.5 sm:w-48">
              <Label htmlFor="renew-billingDay">Billing day</Label>
              <Input
                id="renew-billingDay"
                type="number"
                min={1}
                max={31}
                step={1}
                value={billingDay}
                onChange={(e) => setBillingDay(e.target.valueAsNumber)}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={mutation.isPending || !startDate}>
            {mutation.isPending ? 'Renewing…' : 'Renew lease'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
