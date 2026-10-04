import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import { formatAddress, propertyTypeLabels } from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useProperties } from './api';
import { PropertyFormDialog } from './PropertyFormDialog';

export function PropertiesListPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useProperties();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Properties</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The properties you manage and how many of their units are occupied.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus /> Add property
        </Button>
      </div>

      <div className="mt-6">
        {isPending ? (
          <PropertiesListSkeleton />
        ) : isError ? (
          <PropertiesListError message={error.message} onRetry={() => void refetch()} />
        ) : data.items.length === 0 ? (
          <PropertiesListEmpty onAdd={() => setAddOpen(true)} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Occupancy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((prop) => (
                <TableRow key={prop.id} className="cursor-pointer">
                  <TableCell className="font-medium">
                    <Link
                      to={`/properties/${prop.id}`}
                      className="focus-visible:underline hover:underline"
                    >
                      {prop.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatAddress(prop.address)}
                  </TableCell>
                  <TableCell>{propertyTypeLabels[prop.type]}</TableCell>
                  <TableCell>
                    {prop.occupiedUnitCount} of {prop.unitCount} occupied
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {isFetching && !isPending && (
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            Refreshing…
          </p>
        )}
      </div>

      <PropertyFormDialog open={addOpen} onOpenChange={setAddOpen} />
    </main>
  );
}

function PropertiesListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading properties">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function PropertiesListEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <Building2 className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">No properties yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A property is an address with one or more units. Add your first one to start
          tracking units, leases and payments.
        </p>
      </div>
      <Button onClick={onAdd}>
        <Plus /> Add property
      </Button>
    </div>
  );
}

function PropertiesListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load properties</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
