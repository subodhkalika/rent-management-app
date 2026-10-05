import { createContext, useContext } from 'react';
import type { TenancyContext } from '@rms/contract';

/**
 * Which of the signed-in user's tenancies is currently in view. A tenant can
 * rent from more than one landlord at once (docs/PLAN-V1.md §1.2) — this is
 * resolved by `AppShell` from `MeContext.tenancies` and provided down to
 * whichever portal screen is mounted, so there is exactly one picker, in the
 * one shell, not a copy per screen.
 */
export interface PortalTenancyState {
  selected: TenancyContext;
  tenancies: readonly TenancyContext[];
  setSelected: (tenancy: TenancyContext) => void;
}

export const PortalTenancyCtx = createContext<PortalTenancyState | null>(null);

/** Read the selected tenancy from inside a `/portal/*` screen. Throws if used
 *  outside `RequireTenant` + `AppShell`, which is a programming error, not a
 *  state to render around. */
export function useSelectedTenancy(): PortalTenancyState {
  const value = useContext(PortalTenancyCtx);
  if (!value) {
    throw new Error('useSelectedTenancy must be used within the tenant portal shell');
  }
  return value;
}
