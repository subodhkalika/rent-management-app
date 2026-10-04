import { useState } from 'react';
import { DoorOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatMoney, unitStatusLabels, type Unit } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
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
import { useUnits } from './api';
import { UnitFormDialog } from './UnitFormDialog';
import { DeleteUnitDialog } from './DeleteUnitDialog';

const statusVariant = {
  vacant: 'secondary',
  occupied: 'default',
  unavailable: 'outline',
} as const;

export function UnitsSection({ propertyId }: { propertyId: string }) {
  const { data, isPending, isError, error, refetch } = useUnits(propertyId);
  const [addOpen, setAddOpen] = useState(false);
  const [editingUnit, setEditingUnit] = useState<Unit | null>(null);
  const [deletingUnit, setDeletingUnit] = useState<Unit | null>(null);

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Units</h2>
        <Button onClick={() => setAddOpen(true)}>
          <Plus /> Add unit
        </Button>
      </div>

      <div className="mt-4">
        {isPending ? (
          <UnitsSkeleton />
        ) : isError ? (
          <UnitsError message={error.message} onRetry={() => void refetch()} />
        ) : data.items.length === 0 ? (
          <UnitsEmpty onAdd={() => setAddOpen(true)} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Beds / baths</TableHead>
                <TableHead>Sq ft</TableHead>
                <TableHead>Market rent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-0">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((unit) => (
                <TableRow key={unit.id}>
                  <TableCell className="font-medium">{unit.label}</TableCell>
                  <TableCell>
                    {unit.bedrooms} bd / {unit.bathrooms} ba
                  </TableCell>
                  <TableCell>{unit.squareFeet ? unit.squareFeet.toLocaleString() : '—'}</TableCell>
                  <TableCell>{formatMoney(unit.marketRentCents, unit.currency)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant[unit.status]}>
                      {unitStatusLabels[unit.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${unit.label}`}
                        onClick={() => setEditingUnit(unit)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${unit.label}`}
                        onClick={() => setDeletingUnit(unit)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <UnitFormDialog open={addOpen} onOpenChange={setAddOpen} propertyId={propertyId} />
      {editingUnit && (
        <UnitFormDialog
          open
          onOpenChange={(open) => !open && setEditingUnit(null)}
          propertyId={propertyId}
          unit={editingUnit}
        />
      )}
      {deletingUnit && (
        <DeleteUnitDialog
          open
          onOpenChange={(open) => !open && setDeletingUnit(null)}
          propertyId={propertyId}
          unit={deletingUnit}
        />
      )}
    </section>
  );
}

function UnitsSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading units">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function UnitsEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <DoorOpen className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h3 className="font-medium">No units yet</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          A unit is the rentable thing inside this property — add one to start tracking
          its rent and occupancy.
        </p>
      </div>
      <Button onClick={onAdd}>
        <Plus /> Add unit
      </Button>
    </div>
  );
}

function UnitsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h3 className="font-medium">Couldn't load units</h3>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
