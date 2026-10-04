import { Routes, Route, Navigate } from 'react-router-dom';
import { PropertiesListPage } from '@/features/properties/PropertiesListPage';
import { PropertyDetailPage } from '@/features/properties/PropertyDetailPage';
import { SignInPage } from '@/features/auth/SignInPage';
import { SignUpPage } from '@/features/auth/SignUpPage';
import { OnboardingPage } from '@/features/auth/OnboardingPage';
import { RequireAuth, GuestOnly, RequireNoOrganization } from '@/features/auth/guards';
import { AuthRedirectListener } from '@/features/auth/AuthRedirectListener';
import { AppShell } from '@/components/layout/AppShell';

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
        </Route>

        <Route element={<RequireNoOrganization />}>
          <Route path="/onboarding" element={<OnboardingPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/properties" replace />} />
            <Route path="/properties" element={<PropertiesListPage />} />
            <Route path="/properties/:id" element={<PropertyDetailPage />} />
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
