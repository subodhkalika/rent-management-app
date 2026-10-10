import { formatMoney, type LedgerEntry, type Payment, type RecordPaymentBody } from '@rms/contract';

/**
 * The confirm step for two identical payments (docs/PLAN-PHASE3B.md §4.15 /
 * decision 10 of PLAN-V1 §3.5 superseded, kept as a UI confirm rather than a
 * constraint — there is deliberately no unique index on `payment`). Matches on
 * the fields that make two entries "the same payment" to a human: amount, date,
 * method and kind, among the chain's already-loaded, live entries.
 */
export function findDuplicatePayment(
  entries: readonly LedgerEntry[],
  candidate: Pick<RecordPaymentBody, 'kind' | 'method' | 'amountCents' | 'receivedOn'>,
): Payment | null {
  for (const entry of entries) {
    if (entry.kind !== 'payment') continue;
    const p = entry.payment;
    if (p.voidedAt) continue;
    if (
      p.kind === candidate.kind &&
      p.method === candidate.method &&
      p.amountCents === candidate.amountCents &&
      p.receivedOn === candidate.receivedOn
    ) {
      return p;
    }
  }
  return null;
}

/** "$50 cash on 3 March" — the sentence the duplicate confirm reads back. */
export function describePayment(p: Pick<Payment, 'amountCents' | 'currency'>, methodLabel: string, dateLabel: string): string {
  return `${formatMoney(p.amountCents, p.currency)} ${methodLabel.toLowerCase()} on ${dateLabel}`;
}
