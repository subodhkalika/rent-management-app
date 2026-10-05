import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { updatePortalProfileBody, type PortalProfile, type UpdatePortalProfileBody } from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { applyServerErrors, blankToUndefined, errorMessage } from '@/lib/form-errors';
import { useSelectedTenancy } from './tenancy-context';
import { usePortalProfile, useUpdatePortalProfile } from './api';

function valuesFromProfile(profile: PortalProfile): UpdatePortalProfileBody {
  return {
    phone: profile.phone ?? '',
    emergencyContactName: profile.emergencyContactName ?? '',
    emergencyContactPhone: profile.emergencyContactPhone ?? '',
    remindersOptedOut: profile.remindersOptedOut,
  };
}

export function PortalProfilePage() {
  const { selected } = useSelectedTenancy();
  const { data: profile, isPending, isError, error, refetch } = usePortalProfile(selected.tenantId);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Your profile</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        For {selected.orgName}. Your name and email are set by your landlord and can't be
        changed here.
      </p>

      <div className="mt-6">
        {isPending ? (
          <ProfileSkeleton />
        ) : isError ? (
          <ProfileError message={error.message} onRetry={() => void refetch()} />
        ) : (
          <ProfileForm profile={profile} tenantId={selected.tenantId} />
        )}
      </div>
    </main>
  );
}

function ProfileForm({ profile, tenantId }: { profile: PortalProfile; tenantId: string }) {
  const form = useForm<UpdatePortalProfileBody>({
    resolver: zodResolver(updatePortalProfileBody),
    defaultValues: valuesFromProfile(profile),
  });

  useEffect(() => {
    form.reset(valuesFromProfile(profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const mutation = useUpdatePortalProfile(tenantId);

  const onSubmit = form.handleSubmit((values) => {
    const payload: UpdatePortalProfileBody = {
      phone: blankToUndefined(values.phone),
      emergencyContactName: blankToUndefined(values.emergencyContactName),
      emergencyContactPhone: blankToUndefined(values.emergencyContactPhone),
      remindersOptedOut: values.remindersOptedOut,
    };
    mutation.mutate(payload, {
      onSuccess: () => toast.success('Profile updated'),
      onError: (err) => {
        const appliedToFields = applyServerErrors(err, form.setError);
        if (!appliedToFields) toast.error(errorMessage(err));
      },
    });
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>Set by your landlord.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-muted-foreground">Name</Label>
            <p className="mt-1 text-sm">
              {profile.firstName} {profile.lastName}
            </p>
          </div>
          <div>
            <Label className="text-muted-foreground">Email</Label>
            <p className="mt-1 text-sm">{profile.email ?? '—'}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contact details</CardTitle>
          <CardDescription>What your landlord uses to reach you.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input type="tel" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="emergencyContactName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Emergency contact name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="emergencyContactPhone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Emergency contact phone</FormLabel>
                      <FormControl>
                        <Input type="tel" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="remindersOptedOut"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between rounded-md border p-3">
                    <div>
                      <FormLabel>Rent reminder emails</FormLabel>
                      <p className="text-sm text-muted-foreground">
                        {field.value ? "You won't receive rent reminders." : "You'll receive rent reminders."}
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={!field.value}
                        onCheckedChange={(checked) => field.onChange(!checked)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading profile">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function ProfileError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-6"
    >
      <h2 className="font-medium">Couldn't load your profile</h2>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
