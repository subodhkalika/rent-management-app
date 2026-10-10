import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, RefreshCw, Wallet, Undo2 } from 'lucide-react';
import {
  formatMoney,
  chargeTypeLabels,
  chargeStatusLabels,
  paymentMethodLabels,
  type Charge,
  type Payment,
  type LeaseDetail,
  type LedgerEntry,
  type LedgerLease,
} from '@rms/contract';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCivilDate } from '@/lib/format-civil-date';
import { errorMessage } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { chargeTypeVariant } from '@/features/charges/charge-ui';
import { useGenerateCharges } from '@/features/charges/api';
import { DriftBanner } from '@/features/charges/DriftBanner';
import { GenerateNextPeriodAction } from '@/features/charges/GenerateNextPeriodAction';
import { VoidChargeDialog } from '@/features/charges/VoidChargeDialog';
import { CorrectChargeDialog } from '@/features/charges/CorrectChargeDialog';
import { CreateChargeDialog } from '@/features/charges/CreateChargeDialog';
import { useLeaseBalance, useLeaseLedger } from './api';
import { chargeStatusVariant, paymentKindVariant, formatRunningBalance } from './payment-ui';
import { BalanceChip } from './BalanceChip';
import { RecordPaymentDialog } from './RecordPaymentDialog';
import { VoidPaymentDialog } from './VoidPaymentDialog';
import { CorrectPaymentDialog } from './CorrectPaymentDialog';
import { ReturnDepositDialog } from './ReturnDepositDialog';

/**
 * The lease page's money tab — moved from the flat `/charges` list to
 * `GET /v1/leases/:id/ledger` (docs/PLAN-PHASE3B.md §8.1, frontend task 4):
 * charges and payments interleaved, ascending by effective date, with a running
 * balance, a status pill per charge, and voids struck through and linked to
 * whatever superseded them — never dropped.
 *
 * The owner's own requirement shapes the one thing this panel is strictest
 * about: allocation spans the whole TENANCY, not one lease, so a payment
 * recorded today can clear a charge from a lease that ended last year. Every row
 * carries its own lease, and the instant the chain has more than one, a row from
 * an earlier lease says so in plain text next to the row — never a tooltip.
 *
 * The drift banner keeps reading `/charges` (it needs voided rows and generation
 * keys the ledger does not carry) — two routes, two jobs, per §8.1.
 */
export function LedgerPanel({ lease }: { lease: LeaseDetail }) {
  const { data: ledger, isPending, isError, error, refetch, isFetching } = useLeaseLedger(lease.id);
  const { data: balance } = useLeaseBalance(lease.id);
  const generateMutation = useGenerateCharges(lease.id);

  const [recordOpen, setRecordOpen] = useState(false);
  const [createChargeOpen, setCreateChargeOpen] = useState(false);
  const [returnDepositOpen, setReturnDepositOpen] = useState(false);
  const [voidCharge, setVoidCharge] = useState<Charge | null>(null);
  const [correctCharge, setCorrectCharge] = useState<Charge | null>(null);
  const [voidPayment, setVoidPayment] = useState<Payment | null>(null);
  const [correctPayment, setCorrectPayment] = useState<Payment | null>(null);

  const entries = ledger?.entries ?? [];
  const leasesInChain = ledger?.leases ?? [];
  const chainHasMultipleLeases = leasesInChain.length > 1;

  const chargeSuccessorByOriginal = useMemo(() => {
    const map = new Map<string, Charge>();
    for (const e of entries) {
      if (e.kind === 'charge' && e.charge.supersedesChargeId) map.set(e.charge.supersedesChargeId, e.charge);
    }
    return map;
  }, [entries]);

  const paymentSuccessorByOriginal = useMemo(() => {
    const map = new Map<string, Payment>();
    for (const e of entries) {
      if (e.kind === 'payment' && e.payment.supersedesPaymentId) map.set(e.payment.supersedesPaymentId, e.payment);
    }
    return map;
  }, [entries]);

  const leaseById = useMemo(() => {
    const map = new Map<string, LedgerLease>();
    for (const l of leasesInChain) map.set(l.leaseId, l);
    return map;
  }, [leasesInChain]);

  // The single live, paid deposit charge across the chain, if any — the Return
  // Deposit action's target. More than one (a re-deposited renewal) is rare
  // enough that the action simply does not offer itself; voiding the right one
  // by hand through the row's own actions still works.
  const liveDepositCharges = entries.filter(
    (e): e is Extract<LedgerEntry, { kind: 'charge' }> =>
      e.kind === 'charge' && e.charge.type === 'deposit' && e.charge.voidedAt === null && e.charge.appliedCents > 0,
  );
  const depositCharge =
    liveDepositCharges.length === 1 ? { ...liveDepositCharges[0]!.charge, leaseId: liveDepositCharges[0]!.leaseId } : null;

  const canHaveCharges = lease.status !== 'draft' && lease.status !== 'cancelled';
  const hasAnyPayment = entries.some((e) => e.kind === 'payment');

  function handleGenerate() {
    generateMutation.mutate(undefined, {
      onSuccess: ({ created }) => {
        toast.success(created.length > 0 ? `${created.length} charge(s) generated` : 'Nothing new to generate');
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  }

  return (
    <div>
      {canHaveCharges && (
        <DriftBanner lease={lease} onReviewCharge={setCorrectCharge} onVoidCharge={setVoidCharge} />
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Ledger</h2>
          {balance && <BalanceChip balanceCents={balance.chain.balanceCents} currency={ledger?.currency ?? lease.currency} />}
        </div>
        <div className="flex flex-wrap gap-2">
          {depositCharge && (
            <Button size="sm" variant="outline" onClick={() => setReturnDepositOpen(true)}>
              <Undo2 /> Return deposit
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={handleGenerate} disabled={generateMutation.isPending}>
            <RefreshCw /> {generateMutation.isPending ? 'Generating…' : 'Generate charges'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCreateChargeOpen(true)}>
            <Plus /> Add charge
          </Button>
          <Button size="sm" onClick={() => setRecordOpen(true)}>
            <Wallet /> Record payment
          </Button>
        </div>
      </div>

      {lease.status === 'active' && (
        <div className="mt-1 flex items-center justify-end gap-2">
          {balance && balance.chain.creditCents > 0 && (
            <span className="text-xs text-muted-foreground">
              Credit of {formatMoney(balance.chain.creditCents, ledger?.currency ?? lease.currency)} on this tenancy —
            </span>
          )}
          <GenerateNextPeriodAction lease={lease} />
        </div>
      )}

      <div className="mt-2">
        {isPending ? (
          <LedgerSkeleton />
        ) : isError ? (
          <LedgerError message={error.message} onRetry={() => void refetch()} />
        ) : entries.length === 0 ? (
          <LedgerEmpty onGenerate={handleGenerate} onAdd={() => setCreateChargeOpen(true)} onRecord={() => setRecordOpen(true)} generating={generateMutation.isPending} />
        ) : (
          <>
            {!hasAnyPayment && (
              <p className="mb-2 text-sm text-muted-foreground">
                No payments recorded yet — this is normal for a new lease. Record one once the tenant pays.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Running balance</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) =>
                  entry.kind === 'charge' ? (
                    <ChargeRow
                      key={`charge-${entry.charge.id}`}
                      entry={entry}
                      lease={lease}
                      currency={ledger?.currency ?? lease.currency}
                      leaseLabel={chainHasMultipleLeases ? leaseById.get(entry.leaseId) : undefined}
                      successor={chargeSuccessorByOriginal.get(entry.charge.id)}
                      onVoid={() => setVoidCharge(entry.charge)}
                      onCorrect={() => setCorrectCharge(entry.charge)}
                    />
                  ) : (
                    <PaymentRow
                      key={`payment-${entry.payment.id}`}
                      entry={entry}
                      lease={lease}
                      currency={ledger?.currency ?? lease.currency}
                      leaseLabel={chainHasMultipleLeases ? leaseById.get(entry.leaseId) : undefined}
                      successor={paymentSuccessorByOriginal.get(entry.payment.id)}
                      onVoid={() => setVoidPayment(entry.payment)}
                      onCorrect={() => setCorrectPayment(entry.payment)}
                    />
                  ),
                )}
              </TableBody>
            </Table>
            {ledger?.truncated && (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the first {entries.length} entries — this tenancy's full history is longer.
              </p>
            )}
          </>
        )}
        {isFetching && !isPending && (
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            Refreshing…
          </p>
        )}
      </div>

      <RecordPaymentDialog open={recordOpen} onOpenChange={setRecordOpen} lease={lease} />
      <CreateChargeDialog open={createChargeOpen} onOpenChange={setCreateChargeOpen} leaseId={lease.id} calendar={lease.calendar} />
      <ReturnDepositDialog
        open={returnDepositOpen}
        onOpenChange={setReturnDepositOpen}
        depositCharge={depositCharge}
        currency={ledger?.currency ?? lease.currency}
        calendar={lease.calendar}
        propertyTimezone={lease.propertyTimezone}
      />
      <VoidChargeDialog
        open={voidCharge !== null}
        onOpenChange={(open) => !open && setVoidCharge(null)}
        leaseId={voidCharge?.leaseId ?? lease.id}
        charge={voidCharge}
        calendar={lease.calendar}
      />
      <CorrectChargeDialog
        open={correctCharge !== null}
        onOpenChange={(open) => !open && setCorrectCharge(null)}
        leaseId={correctCharge?.leaseId ?? lease.id}
        charge={correctCharge}
        calendar={lease.calendar}
        currency={lease.currency}
      />
      <VoidPaymentDialog
        open={voidPayment !== null}
        onOpenChange={(open) => !open && setVoidPayment(null)}
        leaseId={voidPayment?.leaseId ?? lease.id}
        payment={voidPayment}
        calendar={lease.calendar}
      />
      <CorrectPaymentDialog
        open={correctPayment !== null}
        onOpenChange={(open) => !open && setCorrectPayment(null)}
        leaseId={correctPayment?.leaseId ?? lease.id}
        payment={correctPayment}
        calendar={lease.calendar}
        propertyTimezone={lease.propertyTimezone}
      />
    </div>
  );
}

/** Shown next to a row whenever the chain has more than one lease — the owner's
 *  own condition for shipping chain-wide allocation at all: "let them know it's
 *  from the previous lease". Silent for the chain's current lease, since most
 *  rows are that one and flagging every row would bury the one flag that matters. */
function LeaseProvenanceBadge({ leaseInfo, calendar }: { leaseInfo: LedgerLease; calendar: LeaseDetail['calendar'] }) {
  if (leaseInfo.isCurrent) return null;
  return (
    <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-500">
      Previous lease, ended {leaseInfo.endDate ? formatCivilDate(leaseInfo.endDate, calendar) : '—'}
    </Badge>
  );
}

function ChargeRow({
  entry,
  lease,
  currency,
  leaseLabel,
  successor,
  onVoid,
  onCorrect,
}: {
  entry: Extract<LedgerEntry, { kind: 'charge' }>;
  lease: LeaseDetail;
  currency: LeaseDetail['currency'];
  leaseLabel: LedgerLease | undefined;
  successor: Charge | undefined;
  onVoid: () => void;
  onCorrect: () => void;
}) {
  const c = entry.charge;
  const voided = c.voidedAt !== null;
  const fromPreviousLease = leaseLabel && !leaseLabel.isCurrent;

  return (
    <TableRow className={cn(voided && 'text-muted-foreground', fromPreviousLease && 'bg-amber-50/50 dark:bg-amber-950/20')}>
      <TableCell className={cn(voided && 'line-through')}>{formatCivilDate(c.dueDate, lease.calendar)}</TableCell>
      <TableCell className={cn(voided && 'line-through')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={chargeTypeVariant[c.type]}>{chargeTypeLabels[c.type]}</Badge>
          <Badge variant={chargeStatusVariant[c.status]}>{chargeStatusLabels[c.status]}</Badge>
          {leaseLabel && <LeaseProvenanceBadge leaseInfo={leaseLabel} calendar={lease.calendar} />}
        </div>
        {c.description && <div className="mt-0.5 text-xs text-muted-foreground">{c.description}</div>}
        {fromPreviousLease && c.appliedCents > 0 && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            Paid using money received on this tenancy — not necessarily under this lease.
          </div>
        )}
        {voided && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {successor
              ? `Superseded — ${formatMoney(successor.amountCents, currency)} due ${formatCivilDate(successor.dueDate, lease.calendar)}`
              : c.voidedReason}
          </div>
        )}
      </TableCell>
      <TableCell className={cn('font-medium', voided && 'line-through')}>{formatMoney(c.amountCents, currency)}</TableCell>
      <TableCell className="text-muted-foreground">{formatRunningBalance(entry.runningBalanceCents, currency)}</TableCell>
      <TableCell className="text-right">
        {!voided && (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={onCorrect}>
              Correct
            </Button>
            <Button size="sm" variant="ghost" onClick={onVoid}>
              Void
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function PaymentRow({
  entry,
  lease,
  currency,
  leaseLabel,
  successor,
  onVoid,
  onCorrect,
}: {
  entry: Extract<LedgerEntry, { kind: 'payment' }>;
  lease: LeaseDetail;
  currency: LeaseDetail['currency'];
  leaseLabel: LedgerLease | undefined;
  successor: Payment | undefined;
  onVoid: () => void;
  onCorrect: () => void;
}) {
  const p = entry.payment;
  const voided = p.voidedAt !== null;
  const fromPreviousLease = leaseLabel && !leaseLabel.isCurrent;

  return (
    <TableRow className={cn(voided && 'text-muted-foreground', fromPreviousLease && 'bg-amber-50/50 dark:bg-amber-950/20')}>
      <TableCell className={cn(voided && 'line-through')}>{formatCivilDate(p.receivedOn, lease.calendar)}</TableCell>
      <TableCell className={cn(voided && 'line-through')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={paymentKindVariant[p.kind]}>{p.kind === 'refund' ? 'Refund' : 'Payment'}</Badge>
          <span className="text-xs text-muted-foreground">{paymentMethodLabels[p.method]}</span>
          {leaseLabel && <LeaseProvenanceBadge leaseInfo={leaseLabel} calendar={lease.calendar} />}
        </div>
        {p.reference && <div className="mt-0.5 text-xs text-muted-foreground">Ref: {p.reference}</div>}
        {p.note && <div className="mt-0.5 text-xs text-muted-foreground">{p.note}</div>}
        {voided && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {successor
              ? `Superseded — ${formatMoney(successor.amountCents, currency)} on ${formatCivilDate(successor.receivedOn, lease.calendar)}`
              : p.voidedReason}
          </div>
        )}
      </TableCell>
      <TableCell className={cn('font-medium', voided && 'line-through')}>{formatMoney(p.amountCents, currency)}</TableCell>
      <TableCell className="text-muted-foreground">{formatRunningBalance(entry.runningBalanceCents, currency)}</TableCell>
      <TableCell className="text-right">
        {!voided && (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={onCorrect}>
              Correct
            </Button>
            <Button size="sm" variant="ghost" onClick={onVoid}>
              Void
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function LedgerSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading ledger">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function LedgerEmpty({
  onGenerate,
  onAdd,
  onRecord,
  generating,
}: {
  onGenerate: () => void;
  onAdd: () => void;
  onRecord: () => void;
  generating: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
      <Wallet className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="font-medium">Nothing on this ledger yet</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Activating a lease generates its rent and deposit charges automatically. Once there's a charge, a payment
          can be recorded against it.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="outline" onClick={onGenerate} disabled={generating}>
          <RefreshCw /> {generating ? 'Generating…' : 'Generate charges'}
        </Button>
        <Button variant="outline" onClick={onAdd}>
          <Plus /> Add charge
        </Button>
        <Button onClick={onRecord}>
          <Wallet /> Record payment
        </Button>
      </div>
    </div>
  );
}

function LedgerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-12 text-center"
    >
      <div>
        <h2 className="font-medium">Couldn't load the ledger</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
