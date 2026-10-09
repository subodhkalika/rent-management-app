import type { ChargeType } from '@rms/contract';

/** Badge variant per charge type, same pattern as `lease-ui.ts`'s status variants
 *  so a type never gets a different colour in two places. */
export const chargeTypeVariant: Record<ChargeType, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  rent: 'default',
  deposit: 'secondary',
  opening_balance: 'secondary',
  late_fee: 'destructive',
  utility: 'outline',
  other: 'outline',
};

/** "17 of 31 days" — the prorated-period disclosure both the landlord ledger and
 *  the tenant portal render verbatim (docs/PLAN-PHASE3A.md §9.2). */
export function formatOccupied(daysOccupied: number, daysInPeriod: number): string {
  return `${daysOccupied} of ${daysInPeriod} days`;
}
