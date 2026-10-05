import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  inviteToken,
  acceptInviteBody,
  type AcceptInviteBody,
  type InvitePreview,
} from '@rms/contract';
import { signOut, useSession } from '@/lib/auth-client';
import { ApiClientError } from '@/lib/api';
import { meKeys } from '@/features/me/api';
import { useAcceptInvite, usePortalInvitePreview } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordInput } from '@/features/auth/PasswordInput';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { applyServerErrors } from '@/lib/form-errors';

/**
 * Every failure mode here — bad token, expired, revoked, already accepted,
 * tenant archived — is served by the API as the same `404 not_found`, on
 * purpose: showing different copy per case would let someone distinguish
 * them, which is exactly the enumeration the uniform response prevents. Do
 * not special-case any of them.
 */
const GENERIC_INVALID_MESSAGE =
  'This invitation is no longer valid. Ask your landlord to send a new one.';

// Reuse the contract's own sub-schema for the signed-out account fields —
// one definition, not a hand-copied validation rule that can drift from it.
const accountSchema = acceptInviteBody.shape.account.unwrap();

export function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const tokenWellFormed = inviteToken.safeParse(token).success;

  const { data: session, isPending: sessionPending } = useSession();
  // `enabled: tokenWellFormed` keeps a malformed token from ever reaching the
  // network — same intent as the early return below, just ordered after the
  // hook call since hooks can't follow a conditional return.
  const {
    data: preview,
    isPending: previewPending,
    isError: previewIsError,
  } = usePortalInvitePreview(token, { enabled: tokenWellFormed });

  if (!tokenWellFormed) {
    return <InvalidInvite />;
  }

  if (sessionPending || previewPending) {
    return (
      <main className="grid min-h-full place-items-center p-6">
        <div className="w-full max-w-sm space-y-3" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </main>
    );
  }

  // The preview endpoint fails with the same uniform 404 as acceptance, for the
  // same reason: a more specific preview error would be the enumeration oracle
  // the accept endpoint was built not to be. Render the identical generic card,
  // never a different message for "preview failed" vs. "accept failed".
  if (previewIsError || !preview) {
    return <InvalidInvite />;
  }

  if (session) {
    return <SignedInAccept token={token} email={session.user.email} preview={preview} />;
  }

  return preview.accountExists ? (
    <SignInToAccept preview={preview} />
  ) : (
    <SignedOutAccept token={token} preview={preview} />
  );
}

/** Who this invite is for and when it lapses — shown read-only before any form,
 *  on every branch of the accept page. The email is never an editable field:
 *  the account is created with this exact value, never one the caller types. */
function InvitePreviewSummary({ preview }: { preview: InvitePreview }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Invited by</dt>
      <dd>{preview.orgName}</dd>
      <dt className="text-muted-foreground">For</dt>
      <dd>{preview.tenantFirstName}</dd>
      <dt className="text-muted-foreground">Email</dt>
      <dd>{preview.email}</dd>
      <dt className="text-muted-foreground">Expires</dt>
      <dd>{new Date(preview.expiresAt).toLocaleString()}</dd>
    </dl>
  );
}

function InvalidInvite() {
  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Invitation not valid</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" aria-live="polite" className="text-sm text-muted-foreground">
            {GENERIC_INVALID_MESSAGE}
          </p>
        </CardContent>
      </Card>
    </main>
  );
}

function errorCopyFor(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'not_found') return GENERIC_INVALID_MESSAGE;
    // 409 conflict carries deliberately specific, server-authored copy (e.g.
    // "an account already exists for this email") — shown as-is, not
    // flattened, unlike the 404 case above.
    if (error.code === 'conflict') return error.message;
  }
  return 'Something went wrong. Please try again.';
}

function SignedOutAccept({ token, preview }: { token: string; preview: InvitePreview }) {
  const mutation = useAcceptInvite();
  const form = useForm<{ name: string; password: string }>({
    resolver: zodResolver(accountSchema),
    defaultValues: { name: '', password: '' },
  });

  if (mutation.isSuccess) {
    // A new account + session was just created server-side. Reload fully so
    // every client-side cache (session store, `/v1/me/context`) is read
    // fresh rather than patched around — this happens once, on the one path
    // that mints a brand new session cookie outside the normal sign-in flow.
    window.location.assign('/portal');
    return null;
  }

  const onSubmit = form.handleSubmit((values) => {
    const body: AcceptInviteBody = { token, account: values };
    mutation.mutate(body, {
      onError: (error) => {
        if (error instanceof ApiClientError && error.code === 'validation_failed') {
          applyServerErrors(error, form.setError);
        }
      },
    });
  });

  const topLevelError =
    mutation.isError &&
    !(mutation.error instanceof ApiClientError && mutation.error.code === 'validation_failed')
      ? errorCopyFor(mutation.error)
      : null;

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Accept your invitation</CardTitle>
          <CardDescription>Create a password to set up your tenant portal account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InvitePreviewSummary preview={preview} />
          <Form {...form}>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Your name</FormLabel>
                    <FormControl>
                      <Input autoComplete="name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <PasswordInput autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {topLevelError && (
                <p role="alert" aria-live="polite" className="text-sm text-destructive">
                  {topLevelError}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={mutation.isPending}>
                {mutation.isPending ? 'Creating account…' : 'Create account & accept invite'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}

function SignedInAccept({
  token,
  email,
  preview,
}: {
  token: string;
  email: string;
  preview: InvitePreview;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useAcceptInvite();
  const [signingOut, setSigningOut] = useState(false);

  const handleConfirm = () => {
    mutation.mutate(
      { token },
      {
        onSuccess: () => {
          // No new session was created — this just attached a second
          // tenancy to the existing login — so refresh the cached context
          // rather than reloading the page.
          void queryClient.invalidateQueries({ queryKey: meKeys.context });
          navigate('/portal', { replace: true });
        },
      },
    );
  };

  const handleNotYou = async () => {
    setSigningOut(true);
    await signOut();
    window.location.reload();
  };

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Accept your invitation</CardTitle>
          <CardDescription>
            You're signed in as <span className="font-medium text-foreground">{email}</span>.
            Confirming attaches this invitation to that account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InvitePreviewSummary preview={preview} />
          {mutation.isError && (
            <p role="alert" aria-live="polite" className="text-sm text-destructive">
              {errorCopyFor(mutation.error)}
            </p>
          )}

          <Button className="w-full" onClick={handleConfirm} disabled={mutation.isPending}>
            {mutation.isPending ? 'Accepting…' : 'Confirm and accept'}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => void handleNotYou()}
            disabled={signingOut}
          >
            Not {email}? Sign out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * The signed-out half of the dual-path flow when `accountExists` is true: this
 * person (very possibly a tenant adding a second landlord) already has a login,
 * so there is no password field to fill in — they sign in instead, and land
 * back here with a session, which renders `SignedInAccept` on the next pass.
 */
function SignInToAccept({ preview }: { preview: InvitePreview }) {
  const location = useLocation();

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Accept your invitation</CardTitle>
          <CardDescription>
            An account already exists for this email. Sign in to accept this invitation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InvitePreviewSummary preview={preview} />
          <Button asChild className="w-full">
            <Link to="/signin" state={{ from: location }}>
              Sign in to accept
            </Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
