import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { tenantFullName, tenantStatusLabels } from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { TenantLeasesCard } from '@/features/leases/TenantLeasesCard';
import { useTenant } from './api';
import { TenantFormDialog } from './TenantFormDialog';
import { DeleteTenantDialog } from './DeleteTenantDialog';
import { PortalAccessPanel } from './PortalAccessPanel';

export function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: tenant, isPending, isError, error, refetch } = useTenant(id ?? '');
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!id) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link
        to="/tenants"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" /> All tenants
      </Link>

      <div className="mt-4">
        {isPending ? (
          <TenantHeaderSkeleton />
        ) : isError ? (
          <TenantHeaderError
            code={error.code}
            message={error.message}
            onRetry={() => void refetch()}
          />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{tenantFullName(tenant)}</h1>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant="outline">{tenantStatusLabels[tenant.status]}</Badge>
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Email</dt>
                <dd>{tenant.email ?? '—'}</dd>
                <dt className="text-muted-foreground">Phone</dt>
                <dd>{tenant.phone ?? '—'}</dd>
                <dt className="text-muted-foreground">Emergency contact</dt>
                <dd>
                  {tenant.emergencyContactName
                    ? `${tenant.emergencyContactName}${tenant.emergencyContactPhone ? ` · ${tenant.emergencyContactPhone}` : ''}`
                    : '—'}
                </dd>
              </dl>
              {tenant.notes && (
                <p className="mt-3 max-w-prose text-sm text-muted-foreground">{tenant.notes}</p>
              )}
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

      {tenant && (
        <>
          <div className="mt-6">
            <PortalAccessPanel tenant={tenant} />
          </div>

          <div className="mt-6">
            <TenantLeasesCard tenantId={tenant.id} />
          </div>

          <TenantFormDialog open={editOpen} onOpenChange={setEditOpen} tenant={tenant} />
          <DeleteTenantDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            tenant={tenant}
            onDeleted={() => navigate('/tenants')}
          />
        </>
      )}
    </main>
  );
}

function TenantHeaderSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading tenant">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-4 w-48" />
    </div>
  );
}

function TenantHeaderError({
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
        {code === 'not_found' ? 'Tenant not found' : "Couldn't load this tenant"}
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
