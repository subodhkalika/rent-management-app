import {
  billingTermsFor,
  chargesDueForGeneration,
  chargeOverdue,
  localToday,
  type IsoDate,
  type LeaseDetail,
} from '@rms/contract';

export interface GenerationPreviewItem {
  generationKey: string;
  dueDate: IsoDate;
  amountCents: number;
}

export interface GenerationPreview {
  items: GenerationPreviewItem[];
  totalCents: number;
  overdueCount: number;
}

/**
 * What `POST /leases/:id/activate` will write, computed the way the generator
 * itself computes it (docs/PLAN-PHASE3A.md §8, §0 decision 10):
 *
 *   - rent periods: `chargesDueForGeneration(terms, today)` — the exact call the
 *     cron and the manual kick both make. No second implementation.
 *   - the deposit and opening-balance rows: each written once, each a direct copy
 *     of an already-stored lease field (`deposit_cents` due `start_date`,
 *     `opening_balance_cents` due `ledger_start_date`), never derived — so there is
 *     nothing here for a second implementation to get wrong. A zero amount writes
 *     neither row, matching the generator.
 *
 * This is the onboarding guard-rail (§8's "the onboarding hazard, named and not
 * solved server-side"): activating a tenancy that started months ago can write
 * several already-overdue charges in one click, and that is correct — the preview
 * exists so it is never a surprise.
 */
export function previewActivationCharges(lease: LeaseDetail): GenerationPreview {
  const today = localToday(lease.propertyTimezone);
  const terms = billingTermsFor(lease);
  const rentCharges = chargesDueForGeneration(terms, today);

  const items: GenerationPreviewItem[] = rentCharges.map((p) => ({
    generationKey: p.generationKey,
    dueDate: p.dueDate,
    amountCents: p.amountCents,
  }));

  if (lease.depositCents > 0) {
    items.push({ generationKey: 'deposit', dueDate: lease.startDate, amountCents: lease.depositCents });
  }
  if (lease.openingBalanceCents > 0) {
    items.push({ generationKey: 'opening', dueDate: lease.ledgerStartDate, amountCents: lease.openingBalanceCents });
  }

  const totalCents = items.reduce((sum, i) => sum + i.amountCents, 0);
  const overdueCount = items.filter((i) => chargeOverdue(i.dueDate, today)).length;

  return { items, totalCents, overdueCount };
}
