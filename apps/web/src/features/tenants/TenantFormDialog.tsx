import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { z } from 'zod';
import {
  createTenantBody,
  tenantStatusLabels,
  type CreateTenantBody,
  type Tenant,
  type TenantStatus,
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
import { useCreateTenant, useUpdateTenant } from './api';
import { applyServerErrors, blankToUndefined, errorMessage } from '@/lib/form-errors';

const tenantStatuses = Object.keys(tenantStatusLabels) as TenantStatus[];

// `status` has a Zod `.default()`, so the schema's input type (what the form
// holds before submit) makes it optional, while its output type (what
// `handleSubmit` hands back, and what the mutation sends) makes it required.
// react-hook-form's resolver generics expect exactly that split.
type TenantFormInput = z.input<typeof createTenantBody>;

const emptyValues: CreateTenantBody = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  notes: '',
  status: 'prospect',
};

function valuesFromTenant(t: Tenant): CreateTenantBody {
  return {
    firstName: t.firstName,
    lastName: t.lastName,
    email: t.email ?? '',
    phone: t.phone ?? '',
    emergencyContactName: t.emergencyContactName ?? '',
    emergencyContactPhone: t.emergencyContactPhone ?? '',
    notes: t.notes ?? '',
    status: t.status,
  };
}

interface TenantFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass the tenant to edit; omit to create a new one. */
  tenant?: Tenant;
}

export function TenantFormDialog({ open, onOpenChange, tenant }: TenantFormDialogProps) {
  const isEditing = !!tenant;
  const form = useForm<TenantFormInput, unknown, CreateTenantBody>({
    resolver: zodResolver(createTenantBody),
    defaultValues: tenant ? valuesFromTenant(tenant) : emptyValues,
  });

  useEffect(() => {
    if (open) form.reset(tenant ? valuesFromTenant(tenant) : emptyValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenant]);

  const createMutation = useCreateTenant();
  const updateMutation = useUpdateTenant(tenant?.id ?? '');
  const mutation = isEditing ? updateMutation : createMutation;

  const onSubmit = form.handleSubmit((values) => {
    const payload: CreateTenantBody = {
      ...values,
      email: blankToUndefined(values.email),
      phone: blankToUndefined(values.phone),
      emergencyContactName: blankToUndefined(values.emergencyContactName),
      emergencyContactPhone: blankToUndefined(values.emergencyContactPhone),
      notes: blankToUndefined(values.notes),
    };
    mutation.mutate(payload, {
      onSuccess: () => {
        toast.success(isEditing ? 'Tenant updated' : 'Tenant added');
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
          <DialogTitle>{isEditing ? 'Edit tenant' : 'Add tenant'}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? 'Update the details for this tenant.'
              : 'Add a tenant you manage leases for. An email lets you invite them to the portal later.'}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>First name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Last name</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email (optional)</FormLabel>
                  <FormControl>
                    <Input type="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone (optional)</FormLabel>
                  <FormControl>
                    <Input type="tel" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="emergencyContactName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Emergency contact (optional)</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="emergencyContactPhone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Emergency phone (optional)</FormLabel>
                    <FormControl>
                      <Input type="tel" {...field} />
                    </FormControl>
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
                        <SelectValue placeholder="Select a status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {tenantStatuses.map((status) => (
                        <SelectItem key={status} value={status}>
                          {tenantStatusLabels[status]}
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
                  <FormLabel>Notes (optional, private)</FormLabel>
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
                {mutation.isPending ? 'Saving…' : isEditing ? 'Save changes' : 'Add tenant'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
