import { useState } from 'react';

/**
 * Persists whether a dismissible banner has been dismissed, per `key`, across
 * reloads — so closing it hides it for good rather than until the next render.
 *
 * Falls back to in-memory state (banner reappears on reload) if `localStorage` is
 * unavailable, e.g. private browsing with storage blocked — never throws.
 */
export function useDismissed(key: string): [boolean, (value: boolean) => void] {
  const [dismissed, setDismissedState] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });

  function setDismissed(value: boolean) {
    setDismissedState(value);
    try {
      if (value) localStorage.setItem(key, '1');
      else localStorage.removeItem(key);
    } catch {
      // Storage not available — state above still works for this session.
    }
  }

  return [dismissed, setDismissed];
}
