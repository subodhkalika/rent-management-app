import { formatMoney, splitBalance, type ChargeStatus, type Currency, type PaymentKind } from '@rms/contract';

/** Badge variant per charge status, on the ledger — same pattern as
 *  `charge-ui.ts`'s type variants, so a status never gets a different colour in
 *  two places. */
export const chargeStatusVariant: Record<ChargeStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  void: 'outline',
  paid: 'secondary',
  partially_paid: 'default',
  overdue: 'destructive',
  unpaid: 'outline',
};

/** Badge variant for a payment row's own kind — a refund reads differently from
 *  money coming in. */
export const paymentKindVariant: Record<PaymentKind, 'default' | 'secondary'> = {
  payment: 'default',
  refund: 'secondary',
};

/** A ledger row's running balance, read the same way every other balance in this
 *  app is read — never a bare signed number (docs/PLAN-PHASE3B.md, the owner's own
 *  requirement: never "-$500"). */
export function formatRunningBalance(balanceCents: number, currency: Currency): string {
  const { owedCents, creditCents } = splitBalance(balanceCents);
  if (owedCents === 0 && creditCents === 0) return 'Settled';
  if (creditCents > 0) return `${formatMoney(creditCents, currency)} credit`;
  return `${formatMoney(owedCents, currency)} owed`;
}
