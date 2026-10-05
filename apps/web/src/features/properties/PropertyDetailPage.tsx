import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Clock, Pencil, Trash2 } from 'lucide-react';
import {
  formatAddress,
  propertyTypeLabels,
  calendarSystemLabels,
  type Property,
} from '@rms/contract';
import { moveOutBillingPolicyTitle, moveOutBillingPolicyHelp, calendarSystemHelp } from './billing-settings-copy';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useDismissed } from '@/lib/use-dismissed';
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

      {property && property.timezone === 'UTC' && (
        <UtcTimezoneBanner property={property} onFix={() => setEditOpen(true)} />
      )}

      {property && <BillingSettingsSummary property={property} />}

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

/** Plain-language summary of the two property-level billing settings — both decide
 *  real money outcomes (what a departing tenant owes, what a billing period even
 *  is), so they belong next to the rest of the property's facts, not buried in the
 *  edit form. */
function BillingSettingsSummary({ property }: { property: Property }) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">Calendar</h2>
        <p className="mt-1 text-sm font-medium">{calendarSystemLabels[property.calendar]}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {calendarSystemHelp[property.calendar]}
        </p>
      </div>
      <div>
        <h2 className="text-sm font-medium text-muted-foreground">Move-out billing</h2>
        <p className="mt-1 text-sm font-medium">
          {moveOutBillingPolicyTitle[property.moveOutBillingPolicy]}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {moveOutBillingPolicyHelp[property.moveOutBillingPolicy]}
        </p>
      </div>
    </div>
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

/**
 * `timezone` was added to the contract after properties could already exist, so
 * every one created before then is sitting at the column default, 'UTC' — wrong for
 * most landlords. This is a setting to confirm, not a data problem, so the copy
 * says what it affects rather than warning about corruption.
 */
function UtcTimezoneBanner({ property, onFix }: { property: Property; onFix: () => void }) {
  const [dismissed, setDismissed] = useDismissed(`property:${property.id}:utc-timezone-banner`);
  if (dismissed) return null;

  return (
    <Alert className="mt-4">
      <Clock />
      <AlertTitle>Confirm this property's timezone</AlertTitle>
      <AlertDescription>
        <p>
          This property is set to UTC. Rent due dates and overdue status are evaluated in a
          property's own timezone, so it's worth confirming UTC is actually right for{' '}
          {property.name}.
        </p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={onFix}>
            Set the correct timezone
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
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
