import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { MeContext } from '@rms/contract';
import { GuestOnly, RequireLandlord, RequireNoLandlordOrg, RequireTenant } from './guards';

const useSession = vi.fn();
const useMeContext = vi.fn();

vi.mock('@/lib/auth-client', () => ({
  useSession: (...args: unknown[]) => useSession(...args),
}));

vi.mock('@/features/me/api', () => ({
  useMeContext: (...args: unknown[]) => useMeContext(...args),
}));

const session = { session: { activeOrganizationId: null }, user: { id: 'u1' } };

function ctx(overrides: Partial<MeContext> = {}): MeContext {
  return {
    user: { id: 'u1', name: 'Dana', email: 'dana@example.com' },
    landlord: null,
    tenancies: [],
    ...overrides,
  };
}

const landlordCtx = ctx({ landlord: { orgId: 'org_1', orgName: 'Acme', role: 'owner' } });
const tenantCtx = ctx({
  tenancies: [{ orgId: 'org_2', orgName: 'Alice Lettings', tenantId: 't1' }],
});
const bothCtx = ctx({
  landlord: { orgId: 'org_1', orgName: 'Acme', role: 'owner' },
  tenancies: [{ orgId: 'org_2', orgName: 'Alice Lettings', tenantId: 't1' }],
});
const neitherCtx = ctx();

/** Every page a guard might redirect to, keyed by path, so a test only has
 *  to say which one is behind the guard — every other one is a plain,
 *  unguarded sibling route standing in for a real destination screen. */
const PAGES: Record<string, string> = {
  '/signin': 'Sign-in page',
  '/properties': 'Properties page',
  '/portal': 'Portal page',
  '/onboarding': 'Onboarding page',
};

function renderGuard(guard: React.ReactElement, guardedPath: string) {
  const siblings = Object.entries(PAGES).filter(([path]) => path !== guardedPath);
  return render(
    <MemoryRouter initialEntries={[guardedPath]}>
      <Routes>
        <Route element={guard}>
          <Route path={guardedPath} element={<div>{PAGES[guardedPath]}</div>} />
        </Route>
        {siblings.map(([path, label]) => (
          <Route key={path} path={path} element={<div>{label}</div>} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireLandlord', () => {
  it('shows a neutral skeleton while the session is loading, never a flash of sign-in', () => {
    useSession.mockReturnValue({ data: null, isPending: true });
    useMeContext.mockReturnValue({ data: undefined, isPending: true, isError: false });
    renderGuard(<RequireLandlord />, '/properties');

    expect(screen.queryByText('Sign-in page')).not.toBeInTheDocument();
    expect(screen.queryByText('Properties page')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated user to /signin', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    useMeContext.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderGuard(<RequireLandlord />, '/properties');

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('renders the protected content for a landlord', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: landlordCtx, isPending: false, isError: false });
    renderGuard(<RequireLandlord />, '/properties');

    expect(await screen.findByText('Properties page')).toBeInTheDocument();
  });

  it('sends a tenant-only user to /portal, never to onboarding', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: tenantCtx, isPending: false, isError: false });
    renderGuard(<RequireLandlord />, '/properties');

    expect(await screen.findByText('Portal page')).toBeInTheDocument();
  });

  it('sends a user with neither actor to /onboarding', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: neitherCtx, isPending: false, isError: false });
    renderGuard(<RequireLandlord />, '/properties');

    expect(await screen.findByText('Onboarding page')).toBeInTheDocument();
  });
});

describe('RequireTenant', () => {
  it('sends a landlord-only user to /properties', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: landlordCtx, isPending: false, isError: false });
    renderGuard(<RequireTenant />, '/portal');

    expect(await screen.findByText('Properties page')).toBeInTheDocument();
  });

  it('renders the portal for a tenant-only user', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: tenantCtx, isPending: false, isError: false });
    renderGuard(<RequireTenant />, '/portal');

    expect(await screen.findByText('Portal page')).toBeInTheDocument();
  });

  it('renders the portal for a user who is both a landlord and a tenant', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: bothCtx, isPending: false, isError: false });
    renderGuard(<RequireTenant />, '/portal');

    expect(await screen.findByText('Portal page')).toBeInTheDocument();
  });
});

describe('GuestOnly', () => {
  it('renders sign-in for a signed-out visitor', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    useMeContext.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderGuard(<GuestOnly />, '/signin');

    expect(await screen.findByText('Sign-in page')).toBeInTheDocument();
  });

  it('redirects a signed-in landlord straight to /properties', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: landlordCtx, isPending: false, isError: false });
    renderGuard(<GuestOnly />, '/signin');

    expect(await screen.findByText('Properties page')).toBeInTheDocument();
  });

  it('redirects a signed-in tenant-only user to /portal, not /onboarding', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: tenantCtx, isPending: false, isError: false });
    renderGuard(<GuestOnly />, '/signin');

    expect(await screen.findByText('Portal page')).toBeInTheDocument();
  });
});

describe('RequireNoLandlordOrg', () => {
  it('lets a tenant-only user onboard to also become a landlord', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: tenantCtx, isPending: false, isError: false });
    renderGuard(<RequireNoLandlordOrg />, '/onboarding');

    expect(await screen.findByText('Onboarding page')).toBeInTheDocument();
  });

  it('sends a user who already has a landlord org to /properties', async () => {
    useSession.mockReturnValue({ data: session, isPending: false });
    useMeContext.mockReturnValue({ data: landlordCtx, isPending: false, isError: false });
    renderGuard(<RequireNoLandlordOrg />, '/onboarding');

    expect(await screen.findByText('Properties page')).toBeInTheDocument();
  });
});
