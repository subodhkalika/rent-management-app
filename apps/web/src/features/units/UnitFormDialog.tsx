import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  createUnitBody,
  unitStatusLabels,
  type CreateUnitBody,
  type Unit,
  type UnitStatus,
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { applyServerErrors, errorMessage } from '@/lib/form-errors';
import { useCreateUnit, useUpdateUnit } from './api';
import { RentInput } from './RentInput';

const unitStatuses = Object.keys(unitStatusLabels) as UnitStatus[];
const currencies = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD'] as const;

// `status` has a Zod `.default()`, so the schema's input type (what the form holds
// before submit) makes it optional, while its output type (what `handleSubmit` hands
// back, and what the mutation sends) makes it required. react-hook-form's resolver
// generics expect exactly that split.
type UnitFormInput = z.input<typeof createUnitBody>;

const emptyValues: CreateUnitBody = {
  label: '',
  bedrooms: 1,
  bathrooms: 1,
  squareFeet: undefined,
  marketRentCents: 0,
  currency: 'USD',
  status: 'vacant',
  notes: '',
};

function valuesFromUnit(unit: Unit): CreateUnitBody {
  return {
    label: unit.label,
    bedrooms: unit.bedrooms,
    bathrooms: unit.bathrooms,
    squareFeet: unit.squareFeet ?? undefined,
    marketRentCents: unit.marketRentCents,
    currency: unit.currency,
    status: unit.status,
    notes: unit.notes ?? '',
  };
}

interface UnitFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  propertyId: string;
  /** Pass the unit to edit; omit to create a new one. */
  unit?: Unit;
}

export function UnitFormDialog({ open, onOpenChange, propertyId, unit }: UnitFormDialogProps) {
  const isEditing = !!unit;
  const form = useForm<UnitFormInput, unknown, CreateUnitBody>({
    resolver: zodResolver(createUnitBody),
    defaultValues: unit ? valuesFromUnit(unit) : emptyValues,
  });

  useEffect(() => {
    if (open) form.reset(unit ? valuesFromUnit(unit) : emptyValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, unit]);

  const createMutation = useCreateUnit(propertyId);
  const updateMutation = useUpdateUnit(propertyId, unit?.id ?? '');
  const mutation = isEditing ? updateMutation : createMutation;

  const onSubmit = form.handleSubmit((values) => {
    mutation.mutate(values, {
      onSuccess: () => {
        toast.success(isEditing ? 'Unit updated' : 'Unit added');
        onOpenChange(false);
      },
      onError: (error) => {
        const appliedToFields = applyServerErrors(error, form.setError);
        if (!appliedToFields) toast.error(errorMessage(error));
      },
    });
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit unit' : 'Add unit'}</DialogTitle>
          <DialogDescription>
            {isEditing ? 'Update the details for this unit.' : 'Add a unit to this property.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Unit label</FormLabel>
                  <FormControl>
                    <Input placeholder="Unit 4B" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="bedrooms"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bedrooms</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        step={1}
                        value={field.value}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        onChange={(e) => field.onChange(e.target.valueAsNumber)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="bathrooms"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bathrooms</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        step={0.5}
                        value={field.value}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        onChange={(e) => field.onChange(e.target.valueAsNumber)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="squareFeet"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sq ft (optional)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={field.value ?? ''}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                        onChange={(e) =>
                          field.onChange(e.target.value === '' ? undefined : e.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="marketRentCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Market rent</FormLabel>
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
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {currencies.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
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
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {unitStatuses.map((status) => (
                        <SelectItem key={status} value={status}>
                          {unitStatusLabels[status]}
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
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (optional)</FormLabel>
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
                {mutation.isPending ? 'Saving…' : isEditing ? 'Save changes' : 'Add unit'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
