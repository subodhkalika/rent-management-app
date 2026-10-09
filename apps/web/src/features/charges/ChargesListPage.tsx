import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Receipt } from 'lucide-react';
import {
  formatMoney,
  chargeOverdue,
  localToday,
  chargeType,
  chargeTypeLabels,
  type ChargeType,
  type ChargeWithLease,
  type OrgChargeListQuery,
} from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCivilDate } from '@/lib/format-civil-date';
import { useProperties } from '@/features/properties/api';
import { useUnits } from '@/features/units/api';
import { chargeTypeVariant } from './charge-ui';
import { useOrgCharges } from './api';

const ALL = '__all__';
const chargeTypes = chargeType.options;

type Filters = Partial<OrgChargeListQuery>;

/**
 * Portfolio-wide charges, across every property (docs/PLAN-PHASE3A.md §9.1
 * `GET /v1/charges`, frontend task 5). Grouped by currency and never summed
 * across them — a landlord with an INR property and an AUD property must never
 * see one combined figure that mixes the two.
 *
 * Due dates here render in plain Gregorian, not each row's own civil calendar:
 * `chargeWithLease` deliberately carries no `calendar` field (only
 * `propertyTimezone`, for overdue), so there is no per-row calendar to format
 * against. The stored date is always Gregorian ISO regardless (docs/DATES.md),
 * so this is a valid rendering, just without the Bikram Sambat dual-calendar
 * enhancement the lease-detail page can show.
 */
export function ChargesListPage() {
  const [filters, setFilters] = useState<Filters>({});
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
  } = useOrgCharges(filters);

  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const hasAnyFilter = Object.values(filters).some((v) => v !== undefined && v !== false);
  const groups = groupByCurrency(items);

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Charges</h1>
        <p className="mt-1 text-sm text-muted-foreground">Every charge across your portfolio, newest due first.</p>
      </div>

      <ChargeFiltersBar filters={filters} onChange={setFilters} />

      <div className="mt-4">
        {isPending ? (
          <ChargesListSkeleton />
        ) : isError ? (
          <ChargesListError message={error.message} onRetry={() => void refetch()} />
        ) : items.length === 0 ? (
          <ChargesListEmpty hasFilter={hasAnyFilter} />
        ) : (
          <>
            {groups.map(([currency, rows]) => (
              <div key={currency} className="mb-6">
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">{currency}</h2>
                <ChargeTable rows={rows} />
              </div>
            ))}
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

function groupByCurrency(items: ChargeWithLease[]): [string, ChargeWithLease[]][] {
  const map = new Map<string, ChargeWithLease[]>();
  for (const c of items) {
    const list = map.get(c.currency) ?? [];
    list.push(c);
    map.set(c.currency, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function ChargeTable({ rows }: { rows: ChargeWithLease[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Due</TableHead>
          <TableHead>Property / unit</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((c) => {
          const overdue = !c.voidedAt && chargeOverdue(c.dueDate, localToday(c.propertyTimezone));
          return (
            <TableRow key={c.id} className={c.voidedAt ? 'text-muted-foreground' : undefined}>
              <TableCell className={c.voidedAt ? 'line-through' : undefined}>
                {formatCivilDate(c.dueDate, 'gregorian')}
                {overdue && (
                  <Badge variant="destructive" className="ml-2">
                    Overdue
                  </Badge>
                )}
                {c.voidedAt && (
                  <Badge variant="outline" className="ml-2">
                    Voided
                  </Badge>
                )}
              </TableCell>
              <TableCell>
                <Link to={`/leases/${c.leaseId}`} className="hover:underline focus-visible:underline">
                  {c.unitLabel}
                </Link>
                <div className="text-xs text-muted-foreground">{c.propertyName}</div>
              </TableCell>
              <TableCell>
                <Badge variant={chargeTypeVariant[c.type]}>{chargeTypeLabels[c.type]}</Badge>
              </TableCell>
              <TableCell className={c.voidedAt ? 'line-through' : 'font-medium'}>
                {formatMoney(c.amountCents, c.currency)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ChargeFiltersBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const propertiesQuery = useProperties();
  const properties = propertiesQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mt-4 flex flex-wrap items-end gap-3">
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

      <FilterField label="Type">
        <Select
          value={filters.type ?? ALL}
          onValueChange={(value) => onChange({ ...filters, type: value === ALL ? undefined : (value as ChargeType) })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {chargeTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {chargeTypeLabels[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterField>

      <FilterField label="From">
        <input
          id="charge-filter-from"
          type="date"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          value={filters.from ?? ''}
          onChange={(e) => onChange({ ...filters, from: e.target.value || undefined })}
        />
      </FilterField>

      <FilterField label="To">
        <input
          id="charge-filter-to"
          type="date"
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
          value={filters.to ?? ''}
          onChange={(e) => onChange({ ...filters, to: e.target.value || undefined })}
        />
      </FilterField>

      <div className="flex items-center gap-2 pb-1.5">
        <Switch
          id="overdue-only"
          checked={filters.overdueOnly ?? false}
          onCheckedChange={(checked) => onChange({ ...filters, overdueOnly: checked })}
        />
        <Label htmlFor="overdue-only">Overdue only</Label>
      </div>

      {hasAnySet(filters) && (
        <Button variant="ghost" size="sm" onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function hasAnySet(filters: Filters): boolean {
  return Object.values(filters).some((v) => v !== undefined && v !== false);
}

function UnitFilter({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
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
  const id = `charge-filter-${label.toLowerCase()}`;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function ChargesListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading charges">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function ChargesListEmpty({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <Receipt className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">{hasFilter ? 'No charges match these filters' : 'No charges yet'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasFilter
            ? 'Try clearing a filter.'
            : 'Charges appear here once a lease is activated and its rent schedule is generated.'}
        </p>
      </div>
    </div>
  );
}

function ChargesListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load charges</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
