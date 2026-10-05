import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { requestPasswordReset, signOut, useSession } from '@/lib/auth-client';
import { forgotPasswordSchema, type ForgotPasswordValues } from './schemas';
import { mapForgotPasswordError } from './auth-errors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

/**
 * Not behind `GuestOnly`: a signed-in user landing here (confused, or
 * testing their memory of a password they use elsewhere) must be told why,
 * not silently redirected to /properties with no explanation — that was the
 * bug. This page checks the session itself and branches.
 */
export function ForgotPasswordPage() {
  const { data: session, isPending: sessionPending } = useSession();

  if (sessionPending) {
    return (
      <main className="grid min-h-full place-items-center p-6">
        <div className="w-full max-w-sm space-y-3" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-10 w-full" />
        </div>
      </main>
    );
  }

  return session ? (
    <AlreadySignedIn email={session.user.email} />
  ) : (
    <ForgotPasswordForm />
  );
}

function AlreadySignedIn({ email }: { email: string }) {
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
    // No navigation needed: `useSession()` above re-renders this same page
    // once signed out, and it will show the actual form.
  };

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">You're already signed in</CardTitle>
          <CardDescription>
            Signed in as <span className="font-medium text-foreground">{email}</span>. To reset
            a different account's password, sign out first.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Button onClick={() => void handleSignOut()} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out and continue'}
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">Back to the app</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function ForgotPasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const form = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    const { error } = await requestPasswordReset({
      email: values.email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) {
      setFormError(mapForgotPasswordError(error.code));
      return;
    }
    // Deliberately the same message whether or not the address has an
    // account — see mapForgotPasswordError.
    setSent(true);
  });

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Reset your password</CardTitle>
          <CardDescription>We'll email you a link to choose a new one.</CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              If an account exists for that email, we've sent a link to reset the password.
              Check your inbox.
            </p>
          ) : (
            <Form {...form}>
              <form onSubmit={onSubmit} noValidate className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" autoComplete="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {formError && (
                  <p role="alert" aria-live="polite" className="text-sm text-destructive">
                    {formError}
                  </p>
                )}

                <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? 'Sending…' : 'Send reset link'}
                </Button>
              </form>
            </Form>
          )}

          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link to="/signin" className="font-medium text-primary hover:underline">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
