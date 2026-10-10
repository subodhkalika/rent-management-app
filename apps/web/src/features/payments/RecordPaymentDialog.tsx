import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  recordPaymentBody,
  paymentMethod,
  paymentMethodLabels,
  localToday,
  formatMoney,
  chargeTypeLabels,
  type RecordPaymentBody,
  type LeaseDetail,
} from '@rms/contract';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CivilDateInput } from '@/components/civil-date-input';
import { RentInput } from '@/features/units/RentInput';
import { blankToUndefined, errorMessage } from '@/lib/form-errors';
import { formatCivilDate } from '@/lib/format-civil-date';
import { useLeaseLedger, useRecordPayment } from './api';
import { previewPaymentAllocation, previewResultingCreditCents, type PreviewCharge } from './allocation-preview';
import { describePayment, findDuplicatePayment } from './payment-helpers';

const methods = paymentMethod.options;

/**
 * `kind` carries `.default('payment')` in the contract, so zod's INPUT type (what
 * the form actually holds before the resolver fills the default in) has it
 * optional — react-hook-form needs that distinguished from the OUTPUT type
 * (`RecordPaymentBody`, what `handleSubmit` hands back), same three-type-parameter
 * pattern `CreateLeasePage` already uses for the same reason.
 */
type RecordPaymentFormInput = z.input<typeof recordPaymentBody>;

interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lease: LeaseDetail;
}

function defaultsFor(lease: LeaseDetail): RecordPaymentFormInput {
  return {
    kind: 'payment',
    method: 'bank_transfer',
    amountCents: 0,
    receivedOn: localToday(lease.propertyTimezone),
    reference: undefined,
    note: undefined,
  };
}

/**
 * Record a payment (or a standalone refund) against this lease. Financially it
 * does not matter which lease in the chain it is recorded against — allocation is
 * chain-wide (docs/PLAN-PHASE3B.md §3.1) — so the preview below is built from the
 * WHOLE chain's charges and payments, not just this lease's.
 *
 * Three things this dialog is careful about:
 *  - `receivedOn` defaults to the PROPERTY's local today, never the browser's, and
 *    a future date is refused before the round trip (§2.5).
 *  - The preview — "this clears March and $200 of April" — comes from
 *    `allocateFifo`, the same function the contract's own fixtures pin (§3.6). If
 *    it ever disagrees with what the server does, the server is right.
 *  - A payment that matches one already on the chain (same amount, date, method,
 *    kind) gets a confirm step, never a silent block — two identical cash
 *    payments on the same day are a real, if unusual, thing (§4.15).
 */
export function RecordPaymentDialog({ open, onOpenChange, lease }: RecordPaymentDialogProps) {
  const { data: ledger } = useLeaseLedger(lease.id);
  const mutation = useRecordPayment(lease.id);
  const [pending, setPending] = useState<RecordPaymentBody | null>(null);

  const today = localToday(lease.propertyTimezone);
  const schema = useMemo(
    () =>
      recordPaymentBody.refine((v) => v.receivedOn <= today, {
        message: "Payments can't be dated in the future",
        path: ['receivedOn'],
      }),
    [today],
  );

  const form = useForm<RecordPaymentFormInput, unknown, RecordPaymentBody>({
    resolver: zodResolver(schema),
    defaultValues: defaultsFor(lease),
  });

  useEffect(() => {
    if (open) {
      form.reset(defaultsFor(lease));
      setPending(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lease.id]);

  const charges: PreviewCharge[] = useMemo(
    () =>
      ledger
        ? ledger.entries
            .filter((e) => e.kind === 'charge')
            .map((e) => ({
              id: e.charge.id,
              dueDate: e.charge.dueDate,
              amountCents: e.charge.amountCents,
              isVoided: e.charge.voidedAt !== null,
              type: e.charge.type,
            }))
        : [],
    [ledger],
  );
  const existingPayments = useMemo(
    () =>
      ledger
        ? ledger.entries
            .filter((e) => e.kind === 'payment')
            .map((e) => ({ kind: e.payment.kind, amountCents: e.payment.amountCents, isVoided: e.payment.voidedAt !== null }))
        : [],
    [ledger],
  );

  // `?? 'payment'` because the form field's own type carries the contract's
  // `.default('payment')` as "optional", even though `defaultsFor` always seeds a
  // concrete value — see `RecordPaymentFormInput` above.
  const watchedKind = form.watch('kind') ?? 'payment';
  const watchedAmount = form.watch('amountCents');

  const preview = useMemo(() => {
    if (!ledger || !watchedAmount || watchedAmount <= 0) return [];
    return previewPaymentAllocation({
      charges,
      existingPayments,
      newPayment: { kind: watchedKind, amountCents: watchedAmount },
    });
  }, [ledger, charges, existingPayments, watchedKind, watchedAmount]);

  const resultingCredit = useMemo(() => {
    if (!ledger || !watchedAmount || watchedAmount <= 0) return 0;
    return previewResultingCreditCents({
      charges,
      existingPayments,
      newPayment: { kind: watchedKind, amountCents: watchedAmount },
    });
  }, [ledger, charges, existingPayments, watchedKind, watchedAmount]);

  function doSubmit(values: RecordPaymentBody) {
    const payload: RecordPaymentBody = {
      ...values,
      reference: blankToUndefined(values.reference),
      note: blankToUndefined(values.note),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        toast.success(values.kind === 'refund' ? 'Refund recorded' : 'Payment recorded');
        onOpenChange(false);
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  }

  const onSubmit = form.handleSubmit((values) => {
    const duplicate = ledger ? findDuplicatePayment(ledger.entries, values) : null;
    if (duplicate) {
      setPending(values);
      return;
    }
    doSubmit(values);
  });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
            <DialogDescription>
              Dated in {lease.propertyName}'s own local time. It does not matter which lease in this tenancy you
              record it against — money is allocated across the whole chain.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>What is this?</FormLabel>
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <label className="flex items-center gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary">
                          <RadioGroupItem value="payment" />
                          Money received
                        </label>
                        <label className="flex items-center gap-2 rounded-md border p-3 text-sm has-[:checked]:border-primary">
                          <RadioGroupItem value="refund" />
                          Money sent back
                        </label>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="amountCents"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount</FormLabel>
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
                    <FormLabel htmlFor="record-payment-receivedOn">Date received</FormLabel>
                    <FormControl>
                      <CivilDateInput
                        id="record-payment-receivedOn"
                        label="Date received"
                        calendar={lease.calendar}
                        value={field.value}
                        onChange={(v) => {
                          field.onChange(v);
                          void form.trigger('receivedOn');
                        }}
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
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Note (optional, private — never shown to the tenant)</FormLabel>
                    <FormControl>
                      <Textarea rows={2} {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <AllocationPreview
                preview={preview}
                resultingCreditCents={resultingCredit}
                currency={lease.currency}
                calendar={lease.calendar}
                kind={watchedKind}
              />

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Recording…' : watchedKind === 'refund' ? 'Record refund' : 'Record payment'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Record this again?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending && (
                <>
                  You already recorded{' '}
                  {describePayment(
                    { amountCents: pending.amountCents, currency: lease.currency },
                    paymentMethodLabels[pending.method],
                    formatCivilDate(pending.receivedOn, lease.calendar),
                  )}{' '}
                  on this tenancy. If this is a second, separate payment, go ahead — if you're not sure, cancel and
                  check the ledger first.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const values = pending;
                setPending(null);
                if (values) doSubmit(values);
              }}
            >
              Record it anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AllocationPreview({
  preview,
  resultingCreditCents,
  currency,
  calendar,
  kind,
}: {
  preview: ReturnType<typeof previewPaymentAllocation>;
  resultingCreditCents: number;
  currency: LeaseDetail['currency'];
  calendar: LeaseDetail['calendar'];
  kind: RecordPaymentBody['kind'];
}) {
  if (preview.length === 0 && resultingCreditCents === 0) return null;

  return (
    <div className="rounded-md border p-3 text-sm" aria-live="polite">
      <p className="font-medium">{kind === 'refund' ? 'This will re-open:' : 'This will cover:'}</p>
      {preview.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          {preview.map((row) => (
            <li key={row.chargeId}>
              {formatMoney(Math.abs(row.deltaCents), currency)} of {chargeTypeLabels[row.type]} due{' '}
              {formatCivilDate(row.dueDate, calendar)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted-foreground">Nothing outstanding — this becomes a credit.</p>
      )}
      {resultingCreditCents > 0 && (
        <p className="mt-1 text-muted-foreground">
          Resulting credit on this tenancy: <strong className="text-foreground">{formatMoney(resultingCreditCents, currency)}</strong>
        </p>
      )}
    </div>
  );
}
