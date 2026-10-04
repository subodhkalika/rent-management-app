import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { organization } from '@/lib/auth-client';
import { onboardingSchema, type OnboardingValues } from './schemas';
import { mapOnboardingError } from './auth-errors';
import { slugify } from './slugify';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

export function OnboardingPage() {
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);
  // Once the user edits the slug directly, stop overwriting it from the name.
  const slugEditedRef = useRef(false);

  const form = useForm<OnboardingValues>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: { name: '', slug: '' },
  });

  const nameValue = form.watch('name');
  useEffect(() => {
    if (slugEditedRef.current) return;
    form.setValue('slug', slugify(nameValue), { shouldValidate: form.formState.isSubmitted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameValue]);

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);

    const { data: org, error: createError } = await organization.create({
      name: values.name,
      slug: values.slug,
    });
    if (createError || !org) {
      setFormError(mapOnboardingError(createError?.code));
      return;
    }

    // The API resolves tenancy from session.activeOrganizationId. The hook that
    // defaults it from the user's earliest membership only runs at sign-in — a user
    // who signed up and created an org in this same session still has it unset.
    // This call must complete before navigating, or the next screen 403s.
    const { error: setActiveError } = await organization.setActive({ organizationId: org.id });
    if (setActiveError) {
      setFormError(mapOnboardingError(setActiveError.code));
      return;
    }

    navigate('/properties', { replace: true });
  });

  return (
    <main className="grid min-h-full place-items-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Create your organization</CardTitle>
          <CardDescription>
            Every property, unit and lease you add belongs to this organization.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Organization name</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Property Management" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        onChange={(e) => {
                          slugEditedRef.current = true;
                          field.onChange(e);
                        }}
                      />
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
                {form.formState.isSubmitting ? 'Creating…' : 'Create organization'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}
