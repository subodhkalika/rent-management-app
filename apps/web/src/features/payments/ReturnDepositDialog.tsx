import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  money,
  paymentMethod,
  paymentMethodLabels,
  isoDate,
  localToday,
  formatMoney,
  splitBalance,
  type AllocatedCharge,
  type CalendarSystem,
  type Currency,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CivilDateInput } from '@/components/civil-date-input';
import { RentInput } from '@/features/units/RentInput';
import { errorMessage } from '@/lib/form-errors';
import { useCreateManualCharge, useVoidCharge } from '@/features/charges/api';
import { useRecordPayment } from './api';

const methods = paymentMethod.options;

const returnDepositFormSchema = z.object({
  refundCents: money,
  damageCents: money,
  method: paymentMethod,
  returnedOn: isoDate,
  reason: z.string().trim().min(10, 'Say why in a sentence').max(500),
});
type ReturnDepositForm = z.infer<typeof returnDepositFormSchema>;

interface ReturnDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The chain's live, paid deposit charge — always voided on the lease it was
   *  actually written against (§3.1: void is lease-scoped even though money is
   *  chain-wide), which is why this carries its own `leaseId`. */
  depositCharge: (AllocatedCharge & { leaseId: string }) | null;
  currency: Currency;
  calendar: CalendarSystem;
  propertyTimezone: string;
}

/**
 * "Return deposit" is NOT a bare refund. A bare refund retreats FIFO from the
 * NEWEST charges, so last month's rent would read unpaid while the deposit still
 * reads paid — arithmetically right, presentationally a disaster. This performs
 * the recipe instead (docs/PLAN-PHASE3B.md §4.9 / §4 row 9): void the deposit
 * charge (so the obligation is cancelled, not just "paid") AND record a refund —
 * optionally with a damage charge for a partial return — so the net lands exactly
 * where the landlord can see it before committing.
 */
export function ReturnDepositDialog({
  open,
  onOpenChange,
  depositCharge,
  currency,
  calendar,
  propertyTimezone,
}: ReturnDepositDialogProps) {
  const voidMutation = useVoidCharge(depositCharge?.leaseId ?? '');
  const paymentMutation = useRecordPayment(depositCharge?.leaseId ?? '');
  const damageChargeMutation = useCreateManualCharge(depositCharge?.leaseId ?? '');

  const form = useForm<ReturnDepositForm>({
    resolver: zodResolver(returnDepositFormSchema),
    defaultValues: {
      refundCents: depositCharge?.amountCents ?? 0,
      damageCents: 0,
      method: 'bank_transfer',
      returnedOn: localToday(propertyTimezone),
      reason: 'Deposit returned at move-out',
    },
  });

  useEffect(() => {
    if (open && depositCharge) {
      form.reset({
        refundCents: depositCharge.amountCents,
        damageCents: 0,
        method: 'bank_transfer',
        returnedOn: localToday(propertyTimezone),
        reason: 'Deposit returned at move-out',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, depositCharge?.id]);

  const refundCents = form.watch('refundCents');
  const damageCents = form.watch('damageCents');

  const netChangeCents = useMemo(() => {
    if (!depositCharge) return 0;
    // Void removes `amountCents` from what's charged (balance falls); the refund
    // removes it from what's paid (balance rises); an optional damage charge adds
    // to what's charged (balance rises). Net is the sum of the three.
    return refundCents + damageCents - depositCharge.amountCents;
  }, [depositCharge, refundCents, damageCents]);

  if (!depositCharge) return null;

  const isPending = voidMutation.isPending || paymentMutation.isPending || damageChargeMutation.isPending;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await voidMutation.mutateAsync({ chargeId: depositCharge.id, body: { reason: values.reason } });
    } catch (error) {
      toast.error(`Couldn't void the deposit charge: ${errorMessage(error)}`);
      return;
    }
    // A full retention (refund of exactly $0) voids the deposit and charges damages
    // with no money changing hands — skip the refund call rather than send an
    // amount the contract's `paymentAmountCents` (strictly > 0) would 422 on.
    if (values.refundCents > 0) {
      try {
        await paymentMutation.mutateAsync({
          kind: 'refund',
          method: values.method,
          amountCents: values.refundCents,
          receivedOn: values.returnedOn,
          note: 'Deposit return',
        });
      } catch (error) {
        toast.error(
          `The deposit charge is voided, but recording the refund failed: ${errorMessage(error)}. Record the refund by hand to finish.`,
        );
        return;
      }
    }
    if (values.damageCents > 0) {
      try {
        await damageChargeMutation.mutateAsync({
          type: 'other',
          amountCents: values.damageCents,
          dueDate: values.returnedOn,
          description: 'Damage deducted from deposit',
        });
      } catch (error) {
        toast.error(
          `The deposit is voided and the refund recorded, but the damage charge failed: ${errorMessage(error)}. Add it by hand to finish.`,
        );
        return;
      }
    }
    toast.success('Deposit returned');
    onOpenChange(false);
  });

  const { owedCents, creditCents } = splitBalance(netChangeCents);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Return the deposit</DialogTitle>
          <DialogDescription>
            This voids the {formatMoney(depositCharge.amountCents, currency)} deposit charge and records a refund —
            not a bare refund, which would reopen the newest rent instead of cancelling the deposit itself.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="refundCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount to return</FormLabel>
                    <FormControl>
                      <RentInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} ref={field.ref} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="damageCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Damage deducted (optional)</FormLabel>
                    <FormControl>
                      <RentInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} ref={field.ref} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              <FormField
                control={form.control}
                name="returnedOn"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="return-deposit-returnedOn">Date returned</FormLabel>
                    <FormControl>
                      <CivilDateInput
                        id="return-deposit-returnedOn"
                        label="Date returned"
                        calendar={calendar}
                        value={field.value}
                        onChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason (recorded against the voided deposit charge)</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="rounded-md border p-3 text-sm" aria-live="polite">
              {netChangeCents === 0 ? (
                <p>This nets to zero — the deposit obligation is cancelled and the money is marked returned.</p>
              ) : creditCents > 0 ? (
                <p>
                  This leaves a <strong className="text-foreground">credit of {formatMoney(creditCents, currency)}</strong> on this
                  tenancy's balance.
                </p>
              ) : (
                <p>
                  This leaves <strong className="text-foreground">{formatMoney(owedCents, currency)} owed</strong> on this tenancy's
                  balance — check the damage amount if that's not expected.
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Processing…' : 'Return deposit'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
