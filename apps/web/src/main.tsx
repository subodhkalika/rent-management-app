import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ApiClientError } from '@/lib/api';
import { publishAuthRedirect } from '@/lib/auth-redirect';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { App } from '@/App';
import '@/index.css';

/**
 * A 401 or 403 from any domain-API call, anywhere in the app, means the session went
 * bad mid-use (expired, or lost its active organization) rather than this particular
 * screen having a bug. Route accordingly instead of rendering the raw error — see
 * docs/TASKS/003-auth-ui.md, "Routing rules". The route guards handle the same two
 * cases on first load; this handles them after.
 */
function handleAuthError(error: unknown) {
  if (!(error instanceof ApiClientError) || !error.isAuth) return;
  publishAuthRedirect(error.code === 'unauthorized' ? 'expired' : 'no-org');
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retrying a 401/403/404 just delays the error state and wastes the free
      // request budget. Only retry what might genuinely be transient.
      retry: (failureCount, error) => {
        if (error instanceof ApiClientError && error.status < 500 && error.status !== 0) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
