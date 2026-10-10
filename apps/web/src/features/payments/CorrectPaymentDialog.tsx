import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  correctPaymentBody,
  paymentMethod,
  paymentMethodLabels,
  formatMoney,
  localToday,
  type Payment,
  type CorrectPaymentBody,
  type CalendarSystem,
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CivilDateInput } from '@/components/civil-date-input';
import { RentInput } from '@/features/units/RentInput';
import { blankToUndefined, errorMessage } from '@/lib/form-errors';
import { formatCivilDate } from '@/lib/format-civil-date';
import { useCorrectPayment } from './api';

const methods = paymentMethod.options;

/** Same reason as `RecordPaymentFormInput` in `RecordPaymentDialog`: `kind`
 *  carries `.default('payment')`, so the form's own (pre-default) type has it
 *  optional even though every caller here always supplies a concrete value. */
type CorrectPaymentFormInput = z.input<typeof correctPaymentBody>;

interface CorrectPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  payment: Payment | null;
  calendar: CalendarSystem;
  propertyTimezone: string;
}

function defaultsFor(payment: Payment | null, tz: string): CorrectPaymentFormInput {
  return {
    kind: payment?.kind ?? 'payment',
    method: payment?.method ?? 'bank_transfer',
    amountCents: payment?.amountCents ?? 0,
    receivedOn: payment?.receivedOn ?? localToday(tz),
    reference: payment?.reference ?? undefined,
    note: payment?.note ?? undefined,
    reason: '',
  };
}

/**
 * A correction never edits the row in place — it voids the original and writes a
 * superseding payment, the same recipe `correctCharge` already uses
 * (docs/PLAN-PHASE3B.md §4 row 5). Both rows stay on the ledger, the original
 * struck through and linked to this one.
 */
export function CorrectPaymentDialog({ open, onOpenChange, leaseId, payment, calendar, propertyTimezone }: CorrectPaymentDialogProps) {
  const form = useForm<CorrectPaymentFormInput, unknown, CorrectPaymentBody>({
    resolver: zodResolver(correctPaymentBody),
    defaultValues: defaultsFor(payment, propertyTimezone),
  });
  const mutation = useCorrectPayment(leaseId);

  useEffect(() => {
    if (open) form.reset(defaultsFor(payment, propertyTimezone));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, payment?.id]);

  if (!payment) return null;

  const onSubmit = form.handleSubmit((values) => {
    const payload: CorrectPaymentBody = {
      ...values,
      reference: blankToUndefined(values.reference),
      note: blankToUndefined(values.note),
    };
    mutation.mutate(
      { paymentId: payment.id, body: payload },
      {
        onSuccess: () => {
          toast.success('Payment corrected');
          onOpenChange(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Correct this payment</DialogTitle>
          <DialogDescription>
            Currently {formatMoney(payment.amountCents, payment.currency)} {paymentMethodLabels[payment.method]}{' '}
            received {formatCivilDate(payment.receivedOn, calendar)}. This voids the original and writes a new row —
            the original stays visible, struck through, linked to this correction.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="amountCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Correct amount</FormLabel>
                    <FormControl>
                      <RentInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} ref={field.ref} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="method"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Method</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {methods.map((m) => (
                          <SelectItem key={m} value={m}>
                            {paymentMethodLabels[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="receivedOn"
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="correct-payment-receivedOn">Date received</FormLabel>
                  <FormControl>
                    <CivilDateInput
                      id="correct-payment-receivedOn"
                      label="Date received"
                      calendar={calendar}
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reference (optional)</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason for the correction</FormLabel>
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
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : 'Supersede payment'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
