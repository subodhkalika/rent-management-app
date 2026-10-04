import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { subscribeToAuthRedirect } from '@/lib/auth-redirect';

/**
 * Mounted once, inside the router. Translates "the session went bad mid-app" signals
 * (published from the TanStack Query cache in `main.tsx` whenever a 401/403 comes
 * back from the domain API) into the same redirects the route guards apply on
 * first load — see docs/TASKS/003-auth-ui.md, "Routing rules".
 */
export function AuthRedirectListener() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(
    () =>
      subscribeToAuthRedirect((reason) => {
        if (reason === 'expired') {
          navigate('/signin', { state: { from: location }, replace: true });
        } else {
          navigate('/onboarding', { replace: true });
        }
      }),
    [navigate, location],
  );

  return null;
}
