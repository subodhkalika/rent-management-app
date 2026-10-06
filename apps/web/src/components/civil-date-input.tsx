import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  BS_MAX_YEAR,
  BS_MIN_YEAR,
  BsDateOutOfRangeError,
  calendarForSystem,
  isoDate,
  type CalendarSystem,
  type IsoDate,
} from '@rms/contract';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatCivilDate } from '@/lib/format-civil-date';
import { cn } from '@/lib/utils';

export interface CivilDateInputProps {
  /**
   * The id a sibling `<Label htmlFor={id}>` already points at in every call site.
   * On a Gregorian property this lands on the native `<input>`, same as before.
   * On a Bikram Sambat property it lands on the year select — the first control
   * in tab order — so existing `<Label htmlFor="...">` markup keeps working
   * unchanged. (The year select also carries its own, more specific
   * `aria-label`, which wins the accessible-name computation over the
   * associated `<label>` — the external label still does its job of making the
   * control click/focusable, it just isn't the thing a screen reader reads.)
   */
  id: string;
  /** The field's human name, e.g. "Start date" — gives the year/month/day
   *  selects their own accessible names (a single `<label>` can only point at
   *  one control) and prefixes the out-of-range error. */
  label: string;
  calendar: CalendarSystem;
  /** A Gregorian `IsoDate`, or `''` for "nothing entered yet" — the same shape
   *  `<input type="date">`'s `value` already has. Never a Bikram Sambat date:
   *  storage, and this prop, stay Gregorian ISO under every calendar. */
  value: string;
  /** Emits a Gregorian `IsoDate`, or `''` when cleared/incomplete — exactly what
   *  the native input's `onChange={(e) => ...(e.target.value)}` already emitted,
   *  so every existing caller stays unchanged but for the component swap. */
  onChange: (value: string) => void;
  /**
   * Whether `''` (nothing entered) is itself a valid, submittable end state —
   * e.g. a rolling lease with no end date. Defaults to `false` (required):
   * the field must end up with a real date, so no clear affordance is offered.
   *
   * When `true` and a date (or, on the Bikram Sambat path, any part of one)
   * is currently picked, a labelled "Clear {label}" control is rendered so the
   * field can always get back to `''` — on both calendars, the same way. Without
   * this, Bikram Sambat's three Radix `Select`s have no empty-value item to pick
   * (Radix forbids one), so once set they could never be unset again.
   */
  optional?: boolean;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/**
 * A civil-date input that speaks the property's own calendar.
 *
 * Gregorian: the native `<input type="date">`, untouched — accessible,
 * localised and keyboard-friendly for free.
 *
 * Bikram Sambat: year / month / day selects driven entirely by
 * `calendarForSystem('bikram_sambat')` — `monthNames` for the month list,
 * `daysInMonth` for the day list (29-32, and recomputed on every year/month
 * change), `clampDayToMonth` for both the clamp-on-overflow decision and the
 * Gregorian conversion in one call. No date arithmetic is written here; see
 * docs/DATES.md and this app's `no-date-arithmetic.guard.test.ts`.
 *
 * The year select is restricted to the calendar's own supported range
 * (`BS_MIN_YEAR`-`BS_MAX_YEAR`, roughly AD 1943-2034), so a landlord can never
 * pick an unschedulable date through this control in the first place — the
 * same boundary the API now enforces at create. A date that arrives from
 * *outside* that picker (an existing stored value, e.g. a lease that predates
 * this boundary) can still fail to decompose; that is reported as a plain,
 * visible error rather than left to render blank.
 */
export function CivilDateInput(props: CivilDateInputProps) {
  if (props.calendar === 'gregorian') return <GregorianDateInput {...props} />;
  return <BikramSambatDateInput {...props} />;
}

/**
 * The clear control both calendar branches share: a labelled (never bare-"×")
 * button that emits `''`. Native `<input type="date">` clearing is inconsistent
 * across browsers — some show a mouse-only, unlabelled "x" in the UA shadow DOM,
 * some show nothing at all — so Gregorian gets this same affordance rather than
 * relying on that. One way to clear a date, on either calendar.
 */
function ClearDateButton({ label, onClear, disabled }: { label: string; onClear: () => void; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Clear ${label.toLowerCase()}`}
      onClick={onClear}
      disabled={disabled}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

function GregorianDateInput({
  id,
  label,
  value,
  onChange,
  disabled,
  optional,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: CivilDateInputProps) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        className="w-auto"
      />
      {optional && value !== '' && <ClearDateButton label={label} onClear={() => onChange('')} disabled={disabled} />}
    </div>
  );
}

interface Picked {
  year: number | null;
  month: number | null;
  day: number | null;
}

const EMPTY_PICKED: Picked = { year: null, month: null, day: null };

const BS_YEARS = Array.from({ length: BS_MAX_YEAR - BS_MIN_YEAR + 1 }, (_, i) => BS_MIN_YEAR + i);

function BikramSambatDateInput({
  id,
  label,
  calendar: system,
  value,
  onChange,
  disabled,
  optional,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: CivilDateInputProps) {
  const calendar = calendarForSystem(system);
  const [picked, setPicked] = useState<Picked>(EMPTY_PICKED);
  const [outOfRange, setOutOfRange] = useState(false);
  // Tracks the last value this component itself produced, so the sync-from-prop
  // logic below can tell "the parent echoed our own change back" (do nothing)
  // apart from "the value changed for some other reason" — a reset to `''`, a
  // different lease loading into the same dialog, etc. `null` never collides
  // with a real `value` (which is always `''` or a validated IsoDate string),
  // so it safely forces the very first sync on mount.
  const lastEmitted = useRef<string | null>(null);

  // Deliberately NOT a `useEffect` — this is React's documented "adjust state
  // during render" pattern (same category as `getDerivedStateFromProps`): it
  // re-derives the selects from an externally-changed `value` synchronously,
  // in the same render, and bails out the instant `value` and `lastEmitted`
  // agree, so it can never loop.
  if (value !== lastEmitted.current) {
    lastEmitted.current = value;
    if (value === '') {
      setPicked(EMPTY_PICKED);
      setOutOfRange(false);
    } else if (isoDate.safeParse(value).success) {
      try {
        setPicked(calendar.decompose(value as IsoDate));
        setOutOfRange(false);
      } catch (error) {
        if (error instanceof BsDateOutOfRangeError) {
          setPicked(EMPTY_PICKED);
          setOutOfRange(true);
        } else {
          throw error;
        }
      }
    }
  }

  function commit(next: Picked) {
    if (next.year === null || next.month === null || next.day === null) {
      setPicked(next);
      setOutOfRange(false);
      lastEmitted.current = '';
      onChange('');
      return;
    }
    // `clampDayToMonth` both clamps an out-of-range day to the target month's
    // length AND converts to the stored Gregorian `IsoDate` — the documented
    // "a day that becomes invalid after a year/month change" behaviour this
    // picker relies on (clamp, not clear), reusing the contract's existing
    // clamp rather than inventing a second one.
    const iso = calendar.clampDayToMonth(next.year, next.month, next.day);
    // Decompose the clamped result back, so the day select itself visibly
    // shows the clamped value (e.g. 32 -> 31) instead of silently going blank
    // because the raw, pre-clamp day no longer matches any option.
    setPicked(calendar.decompose(iso));
    setOutOfRange(false);
    lastEmitted.current = iso;
    onChange(iso);
  }

  const dayCount =
    picked.year !== null && picked.month !== null ? calendar.daysInMonth(picked.year, picked.month) : null;
  const days = dayCount !== null ? Array.from({ length: dayCount }, (_, i) => i + 1) : [];

  const gregorianEquivalent =
    picked.year !== null && picked.month !== null && picked.day !== null
      ? formatCivilDate(calendar.clampDayToMonth(picked.year, picked.month, picked.day), 'gregorian')
      : null;

  const errorId = `${id}-bs-error`;
  const hintId = `${id}-bs-hint`;
  const describedBy = [ariaDescribedBy, outOfRange ? errorId : hintId].filter(Boolean).join(' ');
  // Anything to clear: a full date, a partial pick the landlord wants to abandon,
  // or an out-of-range stored value (selects are back at their placeholders, but
  // `value` itself is still non-empty) — `commit(EMPTY_PICKED)` already handles
  // all three identically via its own "any field null -> emit ''" branch above.
  const showClear = !!optional && (picked.year !== null || picked.month !== null || picked.day !== null || outOfRange);

  return (
    <div className="space-y-1.5">
      <div role="group" aria-label={label} aria-invalid={ariaInvalid || outOfRange} className="flex gap-2">
        <Select
          value={picked.year !== null ? String(picked.year) : ''}
          onValueChange={(v) => commit({ ...picked, year: Number(v) })}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            aria-label={`${label} — year`}
            aria-invalid={ariaInvalid || outOfRange}
            aria-describedby={describedBy || undefined}
            className="w-24"
          >
            <SelectValue placeholder="Year" />
          </SelectTrigger>
          <SelectContent>
            {BS_YEARS.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={picked.month !== null ? String(picked.month) : ''}
          onValueChange={(v) => commit({ ...picked, month: Number(v) })}
          disabled={disabled}
        >
          <SelectTrigger
            id={`${id}-month`}
            aria-label={`${label} — month`}
            aria-invalid={ariaInvalid || outOfRange}
            className="w-32"
          >
            <SelectValue placeholder="Month" />
          </SelectTrigger>
          <SelectContent>
            {calendar.monthNames.map((name, i) => (
              <SelectItem key={name} value={String(i + 1)}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={picked.day !== null ? String(picked.day) : ''}
          onValueChange={(v) => commit({ ...picked, day: Number(v) })}
          disabled={disabled || picked.year === null || picked.month === null}
        >
          <SelectTrigger
            id={`${id}-day`}
            aria-label={`${label} — day`}
            aria-invalid={ariaInvalid || outOfRange}
            className="w-20"
          >
            <SelectValue placeholder="Day" />
          </SelectTrigger>
          <SelectContent>
            {days.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Last in both visual and tab order — year, month, day, then clear —
           since it acts on whatever the three selects together currently hold. */}
        {showClear && <ClearDateButton label={label} onClear={() => commit(EMPTY_PICKED)} disabled={disabled} />}
      </div>

      {/* The Gregorian cross-reference, live — same purpose `formatCivilDate`
         already serves on the read side: their bank and council deal in
         Gregorian, not Bikram Sambat. `aria-live` doubles as the "composed
         value announced" requirement — a screen reader hears the Gregorian
         equivalent change as the selects complete a date. */}
      <p id={hintId} aria-live="polite" className={cn('text-sm text-muted-foreground', outOfRange && 'sr-only')}>
        {gregorianEquivalent ? `Gregorian: ${gregorianEquivalent}` : 'Pick a year, month and day.'}
      </p>

      {outOfRange && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {label} is outside what Bikram Sambat supports here (roughly AD 1943-2034). Showing the
          stored Gregorian date: {formatCivilDate(value as IsoDate, 'gregorian')}. Pick a date within
          range above to change it.
        </p>
      )}
    </div>
  );
}
