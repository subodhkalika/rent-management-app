import { Routes, Route, Navigate } from 'react-router-dom';
import { PropertiesListPage } from '@/features/properties/PropertiesListPage';
import { PropertyDetailPage } from '@/features/properties/PropertyDetailPage';
import { TenantsListPage } from '@/features/tenants/TenantsListPage';
import { TenantDetailPage } from '@/features/tenants/TenantDetailPage';
import { SignInPage } from '@/features/auth/SignInPage';
import { SignUpPage } from '@/features/auth/SignUpPage';
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage';
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage';
import { OnboardingPage } from '@/features/auth/OnboardingPage';
import { RequireLandlord, RequireTenant, GuestOnly, RequireNoLandlordOrg } from '@/features/auth/guards';
import { AuthRedirectListener } from '@/features/auth/AuthRedirectListener';
import { AppShell } from '@/components/layout/AppShell';
import { AcceptInvitePage } from '@/features/portal/AcceptInvitePage';
import { PortalProfilePage } from '@/features/portal/PortalProfilePage';

/**
 * Route table. Feature routes mount here as they land — see docs/TASKS/.
 */
export function App() {
  return (
    <>
      <AuthRedirectListener />
      <Routes>
        <Route element={<GuestOnly />}>
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/signup" element={<SignUpPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Route>

        {/* Public: reached by a token link, signed in or out. Never behind a
            guard — that's the whole point of an invite. */}
        <Route path="/portal/accept" element={<AcceptInvitePage />} />

        <Route element={<RequireNoLandlordOrg />}>
          <Route path="/onboarding" element={<OnboardingPage />} />
        </Route>

        <Route element={<RequireLandlord />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/properties" replace />} />
            <Route path="/properties" element={<PropertiesListPage />} />
            <Route path="/properties/:id" element={<PropertyDetailPage />} />
            <Route path="/tenants" element={<TenantsListPage />} />
            <Route path="/tenants/:id" element={<TenantDetailPage />} />
          </Route>
        </Route>

        <Route element={<RequireTenant />}>
          <Route element={<AppShell />}>
            <Route path="/portal" element={<Navigate to="/portal/profile" replace />} />
            <Route path="/portal/profile" element={<PortalProfilePage />} />
          </Route>
        </Route>

        <Route path="*" element={<Placeholder title="Page not found" />} />
      </Routes>
    </>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <main className="grid min-h-full place-items-center p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Not built yet.</p>
      </div>
    </main>
  );
}
