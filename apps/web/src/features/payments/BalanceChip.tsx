import { formatMoney, splitBalance, type Currency } from '@rms/contract';
import { Badge } from '@/components/ui/badge';

/**
 * Never "-$500". `splitBalance` turns a signed balance into the two words a
 * landlord reads: "Credit $500" or "Owes $500" — see docs/PLAN-PHASE3B.md §5.1
 * and the owner's own requirement that the sign never leak onto the screen.
 */
export function BalanceChip({ balanceCents, currency }: { balanceCents: number; currency: Currency }) {
  const { owedCents, creditCents } = splitBalance(balanceCents);

  if (owedCents === 0 && creditCents === 0) {
    return <Badge variant="outline">Settled</Badge>;
  }
  if (creditCents > 0) {
    return <Badge variant="secondary">Credit {formatMoney(creditCents, currency)}</Badge>;
  }
  return <Badge variant="destructive">Owes {formatMoney(owedCents, currency)}</Badge>;
}
