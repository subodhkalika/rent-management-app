import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PartyPopper } from 'lucide-react';
import { formatMoney, type ArrearsQuery, type ArrearsRow, type Currency } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { useProperties } from '@/features/properties/api';
import { useArrears } from './api';

const ALL = '__all__';
type Filters = Partial<ArrearsQuery>;

/**
 * Who is behind — docs/PLAN-PHASE3B.md §6. Grouped by currency and never summed
 * across them (§6.2): a landlord with a USD property and an INR property sees two
 * totals, never one that mixes them.
 *
 * Keyed on the CHAIN, not the lease — a departed tenant who still owes money is
 * exactly who this page is for, so there is no "active leases only" filter here.
 * And the empty state matters as much as the loaded one: most days, nobody should
 * be on this page at all, and that is the page working, not a blank screen.
 */
export function ArrearsPage() {
  const [filters, setFilters] = useState<Filters>({});
  const { data, isPending, isError, error, refetch } = useArrears(filters);

  const hasFilter = !!filters.propertyId || !!filters.currency || (filters.minCents ?? 1) !== 1;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Arrears</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every tenancy with unpaid, past-due rent — deposits are tracked separately and never counted here.
        </p>
      </div>

      <ArrearsFiltersBar filters={filters} onChange={setFilters} />

      <div className="mt-4">
        {isPending ? (
          <ArrearsSkeleton />
        ) : isError ? (
          <ArrearsError message={error.message} onRetry={() => void refetch()} />
        ) : data.groups.length === 0 ? (
          <ArrearsEmpty hasFilter={hasFilter} />
        ) : (
          <>
            {data.groups.map((group) => (
              <div key={group.currency} className="mb-6">
                <h2 className="mb-2 flex items-baseline gap-2 text-sm font-medium text-muted-foreground">
                  <span>{group.currency}</span>
                  <span>
                    {group.chainCount} {group.chainCount === 1 ? 'tenancy' : 'tenancies'} ·{' '}
                    {formatMoney(group.totalArrearsCents, group.currency)} total
                  </span>
                </h2>
                <ArrearsTable rows={group.rows} currency={group.currency} />
              </div>
            ))}
            {data.truncated && (
              <p className="text-xs text-muted-foreground">
                Showing the first {data.groups.reduce((n, g) => n + g.rows.length, 0)} tenancies — raise the minimum
                amount to narrow this down.
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ArrearsTable({ rows, currency }: { rows: ArrearsRow[]; currency: Currency }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tenant</TableHead>
          <TableHead>Unit</TableHead>
          <TableHead>Arrears</TableHead>
          <TableHead>Oldest overdue</TableHead>
          <TableHead>Days late</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.chainId}>
            <TableCell>
              <Link to={`/leases/${r.leaseId}`} className="hover:underline focus-visible:underline">
                {r.primaryTenantName ?? 'No primary tenant'}
              </Link>
              {!r.isCurrent && (
                <Badge variant="outline" className="ml-2">
                  No longer renting
                </Badge>
              )}
            </TableCell>
            <TableCell>
              <div>{r.unitLabel}</div>
              <div className="text-xs text-muted-foreground">{r.propertyName}</div>
            </TableCell>
            <TableCell className="font-medium">{formatMoney(r.arrearsCents, currency)}</TableCell>
            <TableCell>{formatCivilDate(r.oldestOverdueDueDate, 'gregorian')}</TableCell>
            <TableCell>
              <Badge variant={r.daysLate > 30 ? 'destructive' : 'outline'}>{r.daysLate} days</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ArrearsFiltersBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const propertiesQuery = useProperties();
  const properties = propertiesQuery.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mt-4 flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <label htmlFor="arrears-filter-property" className="text-xs font-medium text-muted-foreground">
          Property
        </label>
        <Select
          value={filters.propertyId ?? ALL}
          onValueChange={(value) => onChange({ ...filters, propertyId: value === ALL ? undefined : value })}
        >
          <SelectTrigger id="arrears-filter-property" className="w-[200px]">
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
      </div>

      <div className="grid gap-1">
        <Label htmlFor="arrears-filter-min">Minimum amount (cents)</Label>
        <Input
          id="arrears-filter-min"
          type="number"
          min={1}
          className="w-[140px]"
          value={filters.minCents ?? 1}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            onChange({ ...filters, minCents: Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1 });
          }}
        />
      </div>

      {(filters.propertyId || filters.currency || (filters.minCents ?? 1) !== 1) && (
        <Button variant="ghost" size="sm" onClick={() => onChange({})}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function ArrearsSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading arrears">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function ArrearsEmpty({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <PartyPopper className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">{hasFilter ? 'No one matches these filters' : 'No one is behind'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {hasFilter
            ? 'Try clearing a filter.'
            : "Every past-due charge across your portfolio is paid off. This page is supposed to be empty most days — that's it working, not a bug."}
        </p>
      </div>
    </div>
  );
}

function ArrearsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load arrears</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
