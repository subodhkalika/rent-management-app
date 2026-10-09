import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { voidChargeBody, formatMoney, type Charge, type VoidChargeBody, type CalendarSystem } from '@rms/contract';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { formatCivilDate } from '@/lib/format-civil-date';
import { errorMessage } from '@/lib/form-errors';
import { useVoidCharge } from './api';

interface VoidChargeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  charge: Charge | null;
  calendar: CalendarSystem;
}

/**
 * Voiding is the only mutation a charge accepts, and it always carries a reason
 * (10..500 chars) — the same `min(10, ...)` rule `correctRentStepBody` already
 * uses, via the same mechanism: `voidChargeBody` as the resolver, so the form and
 * the request are validated by one definition.
 */
export function VoidChargeDialog({ open, onOpenChange, leaseId, charge, calendar }: VoidChargeDialogProps) {
  const form = useForm<VoidChargeBody>({
    resolver: zodResolver(voidChargeBody),
    defaultValues: { reason: '' },
  });
  const mutation = useVoidCharge(leaseId);

  useEffect(() => {
    if (open) form.reset({ reason: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, charge?.id]);

  if (!charge) return null;

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(
      { chargeId: charge.id, body: values },
      {
        onSuccess: () => {
          toast.success('Charge voided');
          onOpenChange(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Void this charge?</DialogTitle>
          <DialogDescription>
            {formatMoney(charge.amountCents, charge.currency)} due {formatCivilDate(charge.dueDate, calendar)}.
            Voiding never deletes the row — it stays visible, struck through, with the reason you give below.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={mutation.isPending}>
                {mutation.isPending ? 'Voiding…' : 'Void charge'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
