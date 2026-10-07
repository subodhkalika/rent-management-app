import {
  rentEscalationMode,
  rentEscalationModeLabels,
  rentEscalationCompounding,
  rentEscalationCompoundingLabels,
  MAX_ESCALATION_INTERVAL_YEARS,
  type RentEscalation,
  type RentEscalationCompounding,
} from '@rms/contract';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { bpsToPercent, percentToBps } from './rent-ladder';

const modes = rentEscalationMode.options;
const compoundings = rentEscalationCompounding.options;
const intervals = Array.from({ length: MAX_ESCALATION_INTERVAL_YEARS }, (_, i) => i + 1);

interface RentEscalationClauseFieldsProps {
  idPrefix: string;
  value: RentEscalation | null;
  onChange: (next: RentEscalation | null) => void;
}

/**
 * The clause itself — mode, rate, interval, compounding — in landlord language, per
 * the escalation plan §6.2 item 1. The rate is entered and displayed as a
 * PERCENTAGE; every conversion to basis points goes through `percentToBps`
 * (`Math.round(pct * 100)`), which is the only place in this app a percentage
 * becomes a bps integer. `intervalYears` reads "every N years" rather than a bare
 * number, and compounding reads as a sentence, not an enum name — both already
 * phrased for a landlord in the contract's own label maps.
 */
export function RentEscalationClauseFields({ idPrefix, value, onChange }: RentEscalationClauseFieldsProps) {
  const mode = value ? 'percent' : 'none';
  const ratePercent = value ? bpsToPercent(value.rateBps) : undefined;

  function setMode(next: string) {
    if (next === 'none') {
      onChange(null);
      return;
    }
    // Switching into "Percentage" for the first time: a sensible, visible default
    // (10% every year, compounding) rather than an invalid zero-rate clause.
    onChange(value ?? { mode: 'percent', rateBps: 1000, intervalYears: 1, compounding: 'compound' });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-mode`}>Rent increases</Label>
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger id={`${idPrefix}-mode`} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modes.map((m) => (
              <SelectItem key={m} value={m}>
                {rentEscalationModeLabels[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {value && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-rate`}>Increase by</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`${idPrefix}-rate`}
                type="number"
                inputMode="decimal"
                min={0.01}
                max={50}
                step={0.01}
                value={ratePercent ?? ''}
                onChange={(e) => {
                  const pct = e.target.valueAsNumber;
                  if (!Number.isFinite(pct) || pct <= 0) return;
                  onChange({ ...value, rateBps: percentToBps(pct) });
                }}
                aria-describedby={`${idPrefix}-rate-suffix`}
              />
              <span id={`${idPrefix}-rate-suffix`} className="text-sm text-muted-foreground">
                %
              </span>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-interval`}>Every</Label>
            <Select
              value={String(value.intervalYears)}
              onValueChange={(v) => onChange({ ...value, intervalYears: Number(v) })}
            >
              <SelectTrigger id={`${idPrefix}-interval`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intervals.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n === 1 ? 'year' : `${n} years`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-compounding`}>Applies to</Label>
            <Select
              value={value.compounding}
              onValueChange={(v) => onChange({ ...value, compounding: v as RentEscalationCompounding })}
            >
              <SelectTrigger id={`${idPrefix}-compounding`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {compoundings.map((c) => (
                  <SelectItem key={c} value={c}>
                    {rentEscalationCompoundingLabels[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
