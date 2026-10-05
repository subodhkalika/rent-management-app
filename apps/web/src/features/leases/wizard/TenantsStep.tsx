import { tenantFullName, tenantStatusLabels } from '@rms/contract';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useTenants } from '@/features/tenants/api';
import type { WizardForm } from './types';

/** Step 2: who's on the lease, and who's primary. Every tenant here is jointly and
 *  severally liable for the whole rent (docs/PLAN-PHASE2.md §5.5) — the copy says
 *  so, rather than implying a split that doesn't exist. */
export function TenantsStep({ form }: { form: WizardForm }) {
  const tenantsQuery = useTenants();
  const tenants = tenantsQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const tenantIds = form.watch('tenantIds') ?? [];
  const primaryTenantId = form.watch('primaryTenantId');

  function toggleTenant(id: string, checked: boolean) {
    const next = checked ? [...tenantIds, id] : tenantIds.filter((t) => t !== id);
    form.setValue('tenantIds', next, { shouldValidate: true });
    if (!checked && primaryTenantId === id) {
      form.setValue('primaryTenantId', next[0] ?? '', { shouldValidate: true });
    } else if (checked && next.length === 1) {
      form.setValue('primaryTenantId', id, { shouldValidate: true });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Tenants</h2>
        <p className="text-sm text-muted-foreground">
          Everyone on this lease is jointly responsible for the full rent. Mark one as
          primary — that's who reminders address.
        </p>
      </div>

      {tenantsQuery.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : tenantsQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load tenants: {tenantsQuery.error.message}
        </p>
      ) : tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You don't have any tenants yet. Add one before creating a lease.
        </p>
      ) : (
        <RadioGroup
          value={primaryTenantId}
          onValueChange={(id) => form.setValue('primaryTenantId', id, { shouldValidate: true })}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <span className="sr-only">Select</span>
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-24">Primary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((t) => {
                const checked = tenantIds.includes(t.id);
                return (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) => toggleTenant(t.id, value === true)}
                        aria-label={`Select ${tenantFullName(t)}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{tenantFullName(t)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {tenantStatusLabels[t.status]}
                    </TableCell>
                    <TableCell>
                      <RadioGroupItem
                        value={t.id}
                        disabled={!checked}
                        aria-label={`Make ${tenantFullName(t)} primary`}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </RadioGroup>
      )}

      {(form.formState.errors.tenantIds ?? form.formState.errors.primaryTenantId) && (
        <p role="alert" aria-live="polite" className="text-sm text-destructive">
          {form.formState.errors.tenantIds?.message ?? form.formState.errors.primaryTenantId?.message}
        </p>
      )}
    </div>
  );
}
