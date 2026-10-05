import type { LeaseStatus } from '@rms/contract';

/** Badge variant per lease status — shared by the list, detail and lease-card
 *  screens so a status never gets a different colour in two places. */
export const leaseStatusVariant: Record<LeaseStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'secondary',
  active: 'default',
  ended: 'outline',
  terminated: 'destructive',
  cancelled: 'outline',
};
