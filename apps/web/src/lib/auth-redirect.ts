/**
 * Any query or mutation anywhere in the app can discover mid-session that the
 * session has gone bad: a 401 means it expired, a 403 means the active
 * organization was cleared. Both need to redirect rather than render a raw
 * error (see docs/TASKS/003-auth-ui.md, "Routing rules"). React Query's cache
 * lives outside the router, so it can't navigate directly — it publishes here,
 * and a listener mounted inside the router (`AuthRedirectListener`) does the
 * actual navigation.
 */

export type AuthRedirectReason = 'expired' | 'no-org';

type Listener = (reason: AuthRedirectReason) => void;

const listeners = new Set<Listener>();

export function publishAuthRedirect(reason: AuthRedirectReason) {
  for (const listener of listeners) listener(reason);
}

/** Returns an unsubscribe function. */
export function subscribeToAuthRedirect(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
