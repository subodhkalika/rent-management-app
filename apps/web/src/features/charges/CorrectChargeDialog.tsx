import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  correctChargeBody,
  formatMoney,
  type Charge,
  type CorrectChargeBody,
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
import { Textarea } from '@/components/ui/textarea';
import { CivilDateInput } from '@/components/civil-date-input';
import { RentInput } from '@/features/units/RentInput';
import { formatCivilDate } from '@/lib/format-civil-date';
import { blankToUndefined, errorMessage } from '@/lib/form-errors';
import { useCorrectCharge } from './api';

interface CorrectChargeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  charge: Charge | null;
  calendar: CalendarSystem;
  currency: Currency;
}

function defaultsFor(charge: Charge | null): CorrectChargeBody {
  return {
    amountCents: charge?.amountCents ?? 0,
    dueDate: charge?.dueDate,
    description: charge?.description ?? undefined,
    reason: '',
  };
}

/**
 * A correction never edits the row in place — it voids the original and writes a
 * superseding row (docs/PLAN-PHASE3A.md §7). `reason` is mandatory, 10..500 chars,
 * the same rule `correctRentStepBody` already enforces for a rent-step correction;
 * `correctChargeBody` is the resolver, so this form and the request share one
 * definition of "valid".
 */
export function CorrectChargeDialog({ open, onOpenChange, leaseId, charge, calendar, currency }: CorrectChargeDialogProps) {
  const form = useForm<CorrectChargeBody>({
    resolver: zodResolver(correctChargeBody),
    defaultValues: defaultsFor(charge),
  });
  const mutation = useCorrectCharge(leaseId);

  useEffect(() => {
    if (open) form.reset(defaultsFor(charge));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, charge?.id]);

  if (!charge) return null;

  const onSubmit = form.handleSubmit((values) => {
    const payload: CorrectChargeBody = {
      ...values,
      description: blankToUndefined(values.description),
    };
    mutation.mutate(
      { chargeId: charge.id, body: payload },
      {
        onSuccess: () => {
          toast.success('Charge corrected');
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
          <DialogTitle>Correct this charge</DialogTitle>
          <DialogDescription>
            Currently {formatMoney(charge.amountCents, currency)} due {formatCivilDate(charge.dueDate, calendar)}.
            This voids the original row and writes a new one — the original stays visible, struck through, linked
            to this correction.
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
                      <RentInput
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="correct-charge-dueDate">Due date</FormLabel>
                    <FormControl>
                      <CivilDateInput
                        id="correct-charge-dueDate"
                        label="Due date"
                        calendar={calendar}
                        value={field.value ?? ''}
                        onChange={(v) => field.onChange(v === '' ? undefined : v)}
                        optional
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} value={field.value ?? ''} />
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
                {mutation.isPending ? 'Saving…' : 'Supersede charge'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
