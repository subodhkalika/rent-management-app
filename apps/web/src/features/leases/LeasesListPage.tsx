import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Plus } from 'lucide-react';
import {
  formatMoney,
  leaseStatusLabels,
  rentFrequencyLabels,
  type LeaseStatus,
} from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCivilDate } from '@/lib/format-civil-date';
import { useProperties } from '@/features/properties/api';
import { useUnits } from '@/features/units/api';
import { useTenants } from '@/features/tenants/api';
import { tenantFullName } from '@rms/contract';
import { useLeases, type LeaseFilters } from './api';
import { leaseStatusVariant } from './lease-ui';

const leaseStatuses = Object.keys(leaseStatusLabels) as LeaseStatus[];
const ALL = '__all__';

export function LeasesListPage() {
  const [filters, setFilters] = useState<LeaseFilters>({});
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useLeases(filters);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const hasAnyFilter = Object.values(filters).some(Boolean);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leases</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every tenancy you've drafted, activated or ended.
          </p>
        </div>
        <Button asChild>
          <Link to="/leases/new">
            <Plus /> New lease
          </Link>
        </Button>
      </div>

      <LeaseFiltersBar filters={filters} onChange={setFilters} />

      <div className="mt-4">
        {isPending ? (
          <LeasesListSkeleton />
        ) : isError ? (
          <LeasesListError message={error.message} onRetry={() => void refetch()} />
        ) : items.length === 0 ? (
          <LeasesListEmpty hasFilter={hasAnyFilter} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Rent</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((l) => (
                  <TableRow key={l.id} className="cursor-pointer">
                    <TableCell className="font-medium">
                      <Link to={`/leases/${l.id}`} className="hover:underline focus-visible:underline">
                        {l.unitLabel}
                      </Link>
                      <div className="text-xs text-muted-foreground">{l.propertyName}</div>
                    </TableCell>
                    <TableCell>{l.primaryTenantName ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatCivilDate(l.startDate, l.calendar)} –{' '}
                      {l.endDate ? formatCivilDate(l.endDate, l.calendar) : 'rolling'}
                    </TableCell>
                    <TableCell>
                      {formatMoney(l.rentCents, l.currency)}
                      <span className="text-muted-foreground"> / {rentFrequencyLabels[l.rentFrequency].toLowerCase()}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={leaseStatusVariant[l.status]}>{leaseStatusLabels[l.status]}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasNextPage && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
        {isFetching && !isPending && !isFetchingNextPage && (
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            Refreshing…
          </p>
        )}
      </div>
    </main>
  );
}

function LeaseFiltersBar({
  filters,
  onChange,
}: {
  filters: LeaseFilters;
  onChange: (filters: LeaseFilters) => void;
}) {
  const propertiesQuery = useProperties();
  const tenantsQuery = useTenants();
  const properties = propertiesQuery.data?.pages.flatMap((p) => p.items) ?? [];
  const tenants = tenantsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <FilterField label="Status">
        <Select
          value={filters.status ?? ALL}
          onValueChange={(value) => onChange({ ...filters, status: value === ALL ? undefined : (value as LeaseStatus) })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {leaseStatuses.map((status) => (
              <SelectItem key={status} value={status}>
                {leaseStatusLabels[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>

      <FilterField label="Property">
        <Select
          value={filters.propertyId ?? ALL}
          onValueChange={(value) =>
            onChange({ ...filters, propertyId: value === ALL ? undefined : value, unitId: undefined })
          }
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All properties" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All properties</SelectItem>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>

      <FilterField label="Unit">
        <UnitFilter filters={filters} onChange={onChange} />
      </FilterField>

      <FilterField label="Tenant">
        <Select
          value={filters.tenantId ?? ALL}
          onValueChange={(value) => onChange({ ...filters, tenantId: value === ALL ? undefined : value })}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All tenants" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All tenants</SelectItem>
            {tenants.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {tenantFullName(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>

      {(filters.status || filters.propertyId || filters.unitId || filters.tenantId) && (
        <Button variant="ghost" size="sm" onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

/** Only meaningful once a property is chosen — a unit id alone is ambiguous
 *  across properties in the UI (though not in the API), so this stays disabled
 *  with an explanatory placeholder until then. */
function UnitFilter({
  filters,
  onChange,
}: {
  filters: LeaseFilters;
  onChange: (filters: LeaseFilters) => void;
}) {
  const unitsQuery = useUnits(filters.propertyId ?? '');
  const units = unitsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Select
      disabled={!filters.propertyId}
      value={filters.unitId ?? ALL}
      onValueChange={(value) => onChange({ ...filters, unitId: value === ALL ? undefined : value })}
    >
      <SelectTrigger className="w-[180px]">
        <SelectValue placeholder={filters.propertyId ? 'All units' : 'Pick a property first'} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All units</SelectItem>
        {units.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  const id = `lease-filter-${label.toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function LeasesListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading leases">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function LeasesListEmpty({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <FileText className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">{hasFilter ? 'No leases match these filters' : 'No leases yet'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasFilter
            ? 'Try clearing a filter.'
            : 'A lease ties a tenant to a unit for a term and a rent. Create your first one to start tracking rent schedules.'}
        </p>
      </div>
      {!hasFilter && (
        <Button asChild>
          <Link to="/leases/new">
            <Plus /> New lease
          </Link>
        </Button>
      )}
    </div>
  );
}

function LeasesListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load leases</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
