import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  createChargeBody,
  manualChargeType,
  chargeTypeLabels,
  type CreateChargeBody,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CivilDateInput } from '@/components/civil-date-input';
import { RentInput } from '@/features/units/RentInput';
import { blankToUndefined, errorMessage } from '@/lib/form-errors';
import { useCreateManualCharge } from './api';

const manualTypes = manualChargeType.options;

interface CreateChargeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  calendar: CalendarSystem;
}

const emptyValues: CreateChargeBody = {
  type: 'other',
  amountCents: 0,
  dueDate: '',
  periodStart: undefined,
  periodEnd: undefined,
  description: undefined,
};

/**
 * A charge a landlord raises by hand — a late fee, a utility bill, a one-off
 * deposit. `rent` is deliberately absent from the type choices: the generator owns
 * it, and a manual rent charge would compete for a generation key (422 if tried —
 * see `manualChargeType` in the contract).
 */
export function CreateChargeDialog({ open, onOpenChange, leaseId, calendar }: CreateChargeDialogProps) {
  const form = useForm<CreateChargeBody>({
    resolver: zodResolver(createChargeBody),
    defaultValues: emptyValues,
  });
  const mutation = useCreateManualCharge(leaseId);

  useEffect(() => {
    if (open) form.reset(emptyValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = form.handleSubmit((values) => {
    const payload: CreateChargeBody = { ...values, description: blankToUndefined(values.description) };
    mutation.mutate(payload, {
      onSuccess: () => {
        toast.success('Charge added');
        onOpenChange(false);
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a charge</DialogTitle>
          <DialogDescription>A one-off charge outside the rent schedule — a late fee, a utility bill, or similar.</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {manualTypes.map((t) => (
                        <SelectItem key={t} value={t}>
                          {chargeTypeLabels[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                    <FormLabel htmlFor="create-charge-dueDate">Due date</FormLabel>
                    <FormControl>
                      <CivilDateInput
                        id="create-charge-dueDate"
                        label="Due date"
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="periodStart"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="create-charge-periodStart">Period start (optional)</FormLabel>
                    <FormControl>
                      <CivilDateInput
                        id="create-charge-periodStart"
                        label="Period start"
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
              <FormField
                control={form.control}
                name="periodEnd"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel htmlFor="create-charge-periodEnd">Period end (optional)</FormLabel>
                    <FormControl>
                      <CivilDateInput
                        id="create-charge-periodEnd"
                        label="Period end"
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

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? 'Adding…' : 'Add charge'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
