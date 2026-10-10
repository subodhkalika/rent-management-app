import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { voidPaymentBody, formatMoney, paymentMethodLabels, type Payment, type VoidPaymentBody, type CalendarSystem } from '@rms/contract';
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
import { useVoidPayment } from './api';

interface VoidPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  payment: Payment | null;
  calendar: CalendarSystem;
}

/**
 * Void means "this never happened, or I recorded it wrong" — a bounced cheque. If
 * money really did move and you are sending it back, that is a REFUND, not a
 * void — use Record payment with "Money sent back" instead. Getting these two
 * backwards is the one way this ledger can lie (docs/PLAN-PHASE3B.md §4.7), so the
 * copy below says it in those words rather than leaving it to a tooltip.
 */
export function VoidPaymentDialog({ open, onOpenChange, leaseId, payment, calendar }: VoidPaymentDialogProps) {
  const form = useForm<VoidPaymentBody>({
    resolver: zodResolver(voidPaymentBody),
    defaultValues: { reason: '' },
  });
  const mutation = useVoidPayment(leaseId);

  useEffect(() => {
    if (open) form.reset({ reason: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payment?.id]);

  if (!payment) return null;

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(
      { paymentId: payment.id, body: values },
      {
        onSuccess: () => {
          toast.success('Payment voided');
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
          <DialogTitle>Void this payment?</DialogTitle>
          <DialogDescription>
            {formatMoney(payment.amountCents, payment.currency)} {paymentMethodLabels[payment.method]} received{' '}
            {formatCivilDate(payment.receivedOn, calendar)}.
            <br />
            <strong className="text-foreground">Void means this never happened, or you recorded it wrong</strong> —
            a bounced cheque, a duplicate entry. If the money really did arrive and you are sending it back, cancel
            this and record a <strong className="text-foreground">refund</strong> instead — that means it happened
            and you sent money back.
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
                {mutation.isPending ? 'Voiding…' : 'Void payment'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
