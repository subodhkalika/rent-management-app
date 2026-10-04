import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { formatAddress, propertyTypeLabels } from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { UnitsSection } from '@/features/units/UnitsSection';
import { useProperty } from './api';
import { PropertyFormDialog } from './PropertyFormDialog';
import { DeletePropertyDialog } from './DeletePropertyDialog';

export function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: property, isPending, isError, error, refetch } = useProperty(id ?? '');
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!id) return null;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <Link
        to="/properties"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" /> All properties
      </Link>

      <div className="mt-4">
        {isPending ? (
          <PropertyHeaderSkeleton />
        ) : isError ? (
          <PropertyHeaderError
            code={error.code}
            message={error.message}
            onRetry={() => void refetch()}
          />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{property.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatAddress(property.address)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {propertyTypeLabels[property.type]} · {property.occupiedUnitCount} of{' '}
                {property.unitCount} occupied
              </p>
              {property.notes && <p className="mt-3 max-w-prose text-sm">{property.notes}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil /> Edit
              </Button>
              <Button variant="outline" onClick={() => setDeleteOpen(true)}>
                <Trash2 /> Delete
              </Button>
            </div>
          </div>
        )}
      </div>

      <UnitsSection propertyId={id} />

      {property && (
        <>
          <PropertyFormDialog open={editOpen} onOpenChange={setEditOpen} property={property} />
          <DeletePropertyDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            property={property}
            onDeleted={() => navigate('/properties')}
          />
        </>
      )}
    </main>
  );
}

function PropertyHeaderSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading property">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-4 w-48" />
    </div>
  );
}

function PropertyHeaderError({
  code,
  message,
  onRetry,
}: {
  code: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/30 bg-destructive/5 p-6">
      <h1 className="font-medium">
        {code === 'not_found' ? 'Property not found' : "Couldn't load this property"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {code !== 'not_found' && (
        <Button variant="outline" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
