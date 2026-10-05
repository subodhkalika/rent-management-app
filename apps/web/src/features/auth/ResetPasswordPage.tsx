import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { resetPassword, signOut, useSession } from '@/lib/auth-client';
import { resetPasswordSchema, type ResetPasswordValues } from './schemas';
import { mapResetPasswordError } from './auth-errors';
import { PasswordInput } from './PasswordInput';
import { Button } from '@/components/ui/button';
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
 * Works regardless of session state. A valid token is proof enough — it was
 * emailed to the account's address — so someone who stayed signed in on this
 * browser and clicks the link must be able to finish the reset without
 * being bounced. If a session exists it's signed out as part of a
 * successful reset, since the password just changed underneath it; the
 * previous session cookie should not continue to work.
 */
export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const [formError, setFormError] = useState<string | null>(null);
  const { data: session } = useSession();

  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  if (!token) {
    return (
      <main className="grid min-h-full place-items-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">Reset link not valid</CardTitle>
          </CardHeader>
          <CardContent>
            <p role="alert" aria-live="polite" className="text-sm text-muted-foreground">
              This reset link is missing its token. Request a new one.
            </p>
            <p className="mt-4 text-center text-sm">
              <Link to="/forgot-password" className="font-medium text-primary hover:underline">
                Request a new link
              </Link>
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    const { error } = await resetPassword({ newPassword: values.password, token });
    if (error) {
      setFormError(mapResetPasswordError(error.code));
      return;
    }
    // The password just changed under whatever session was active — sign it
    // out rather than leave a now-stale-credentialed session live.
    if (session) await signOut();
    toast.success('Password updated. Sign in with your new password.');
    navigate('/signin', { replace: true });
  });

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Choose a new password</CardTitle>
          <CardDescription>Make it at least 8 characters.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New password</FormLabel>
                    <FormControl>
                      <PasswordInput autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm password</FormLabel>
                    <FormControl>
                      <PasswordInput autoComplete="new-password" {...field} />
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
                {form.formState.isSubmitting ? 'Saving…' : 'Save new password'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}
