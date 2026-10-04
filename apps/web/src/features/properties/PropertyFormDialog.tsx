import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  createPropertyBody,
  propertyTypeLabels,
  type CreatePropertyBody,
  type Property,
  type PropertyType,
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
import { useCreateProperty, useUpdateProperty } from './api';
import { applyServerErrors, blankToUndefined, errorMessage } from '@/lib/form-errors';

const propertyTypes = Object.keys(propertyTypeLabels) as PropertyType[];

const emptyValues: CreatePropertyBody = {
  name: '',
  type: 'single_family',
  address: { line1: '', line2: '', city: '', region: '', postalCode: '', country: 'US' },
  notes: '',
};

function valuesFromProperty(property: Property): CreatePropertyBody {
  return {
    name: property.name,
    type: property.type,
    address: property.address,
    notes: property.notes ?? '',
  };
}

interface PropertyFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass the property to edit; omit to create a new one. */
  property?: Property;
}

export function PropertyFormDialog({ open, onOpenChange, property }: PropertyFormDialogProps) {
  const isEditing = !!property;
  const form = useForm<CreatePropertyBody>({
    resolver: zodResolver(createPropertyBody),
    defaultValues: property ? valuesFromProperty(property) : emptyValues,
  });

  // Reset to the right defaults each time the dialog opens, for whichever property
  // (or none) it was opened with.
  useEffect(() => {
    if (open) form.reset(property ? valuesFromProperty(property) : emptyValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, property]);

  const createMutation = useCreateProperty();
  const updateMutation = useUpdateProperty(property?.id ?? '');
  const mutation = isEditing ? updateMutation : createMutation;

  const onSubmit = form.handleSubmit((values) => {
    const payload: CreatePropertyBody = {
      ...values,
      address: { ...values.address, line2: blankToUndefined(values.address.line2) },
      notes: blankToUndefined(values.notes),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        toast.success(isEditing ? 'Property updated' : 'Property added');
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
          <DialogTitle>{isEditing ? 'Edit property' : 'Add property'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the details for this property.'
              : 'Add a property to start tracking its units.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="123 Main St" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {propertyTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {propertyTypeLabels[type]}
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
                name="address.line1"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Street address</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address.line2"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Apt / suite (optional)</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address.city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address.region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>State / region</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address.postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Postal code</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="address.country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Country</FormLabel>
                    <FormControl>
                      <Input placeholder="US" maxLength={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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
                {mutation.isPending ? 'Saving…' : isEditing ? 'Save changes' : 'Add property'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
