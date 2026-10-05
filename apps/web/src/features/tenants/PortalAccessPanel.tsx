import { useState } from 'react';
import { toast } from 'sonner';
import { Mail, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { portalAccessLabels, type Tenant } from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CopyButton } from '@/components/copy-button';
import { errorMessage } from '@/lib/form-errors';
import { useInviteTenant, useRevokePortalAccess } from './api';

interface PortalAccessPanelProps {
  tenant: Tenant;
}

/**
 * The portal-access lifecycle for one tenant: none -> invited -> active, with
 * revoke available from invited or active, and re-invite available from none
 * or revoked.
 *
 * The invite link returned by the server exists exactly once, in the
 * creation response — see docs/PLAN-V1.md §1.3. It is held only in this
 * mutation's own `data`, shown in `InviteLinkDialog`, and explicitly cleared
 * with `mutation.reset()` the moment that dialog closes, so it never
 * outlives the one screen it's shown on.
 */
export function PortalAccessPanel({ tenant }: PortalAccessPanelProps) {
  const inviteMutation = useInviteTenant(tenant.id);
  const revokeMutation = useRevokePortalAccess(tenant.id);
  const [confirmRevokeOpen, setConfirmRevokeOpen] = useState(false);

  const handleInvite = () => {
    inviteMutation.mutate(undefined, {
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  const handleRevoke = () => {
    revokeMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(
          tenant.portalAccess === 'active' ? 'Portal access revoked' : 'Invite revoked',
        );
        setConfirmRevokeOpen(false);
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  const canInvite = tenant.portalAccess === 'none' || tenant.portalAccess === 'revoked';
  const canResend = tenant.portalAccess === 'invited';
  const canRevoke = tenant.portalAccess === 'invited' || tenant.portalAccess === 'active';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Portal access</CardTitle>
        <CardDescription>Whether this tenant can sign in to see their own ledger.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusIcon status={tenant.portalAccess} />
          <Badge variant={tenant.portalAccess === 'active' ? 'default' : 'secondary'}>
            {portalAccessLabels[tenant.portalAccess]}
          </Badge>
          {tenant.portalAccess === 'active' && tenant.portalEmail && (
            <span className="text-sm text-muted-foreground">
              signed in as {tenant.portalEmail}
            </span>
          )}
        </div>

        {tenant.portalAccess === 'invited' && (
          <p className="text-sm text-muted-foreground">
            Waiting for them to open the invite link and accept. Resend revokes the old link
            and issues a new one.
          </p>
        )}
        {tenant.portalAccess === 'revoked' && (
          <p className="text-sm text-muted-foreground">
            Access was revoked. Inviting again issues a brand new link.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {(canInvite || canResend) && (
            <Button
              onClick={handleInvite}
              disabled={!tenant.email || inviteMutation.isPending}
              aria-describedby={!tenant.email ? 'invite-disabled-reason' : undefined}
            >
              {inviteMutation.isPending
                ? 'Sending…'
                : canResend
                  ? 'Resend invite'
                  : 'Invite to portal'}
            </Button>
          )}
          {canRevoke && (
            <Button
              variant="outline"
              onClick={() => setConfirmRevokeOpen(true)}
              disabled={revokeMutation.isPending}
            >
              {tenant.portalAccess === 'active' ? 'Revoke access' : 'Revoke invite'}
            </Button>
          )}
        </div>

        {!tenant.email && (canInvite || canResend) && (
          <p id="invite-disabled-reason" className="text-sm text-muted-foreground">
            Add an email address to this tenant before inviting them to the portal.
          </p>
        )}
      </CardContent>

      <InviteLinkDialog
        invite={inviteMutation.data ?? null}
        onClose={() => inviteMutation.reset()}
      />

      <AlertDialog open={confirmRevokeOpen} onOpenChange={setConfirmRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tenant.portalAccess === 'active' ? 'Revoke portal access?' : 'Revoke this invite?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tenant.portalAccess === 'active'
                ? 'They will lose access to the portal immediately. You can invite them again later.'
                : 'The invite link will stop working. You can send a new one at any time.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revokeMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                handleRevoke();
              }}
            >
              {revokeMutation.isPending ? 'Revoking…' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function StatusIcon({ status }: { status: Tenant['portalAccess'] }) {
  switch (status) {
    case 'active':
      return <ShieldCheck className="size-4 text-primary" aria-hidden="true" />;
    case 'invited':
      return <Mail className="size-4 text-muted-foreground" aria-hidden="true" />;
    case 'revoked':
      return <ShieldOff className="size-4 text-muted-foreground" aria-hidden="true" />;
    default:
      return <ShieldAlert className="size-4 text-muted-foreground" aria-hidden="true" />;
  }
}

function InviteLinkDialog({
  invite,
  onClose,
}: {
  invite: { url: string; email: string; expiresAt: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!invite} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite link created</DialogTitle>
          <DialogDescription>
            For {invite?.email}. Expires{' '}
            {invite ? new Date(invite.expiresAt).toLocaleDateString() : ''}.
          </DialogDescription>
        </DialogHeader>

        <div
          role="alert"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
        >
          This link is shown <strong>once</strong>. Copy it now — the server cannot show it to
          you again. If it's lost, revoke this invite and send a new one.
        </div>

        <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
          <code className="flex-1 overflow-x-auto text-xs break-all">{invite?.url}</code>
          {invite && <CopyButton value={invite.url} />}
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
