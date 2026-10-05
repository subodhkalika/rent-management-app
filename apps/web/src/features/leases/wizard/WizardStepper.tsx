import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A non-interactive progress indicator — navigation stays on the Back/Next
 *  buttons so a step is never skipped without its fields being validated. */
export function WizardStepper({ steps, currentIndex }: { steps: readonly string[]; currentIndex: number }) {
  return (
    <ol className="mt-6 flex items-center gap-2" aria-label="Lease creation steps">
      {steps.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming';
        return (
          <li key={step} className="flex flex-1 items-center gap-2">
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium',
                state === 'done' && 'border-primary bg-primary text-primary-foreground',
                state === 'current' && 'border-primary text-primary',
                state === 'upcoming' && 'border-muted-foreground/30 text-muted-foreground',
              )}
            >
              {state === 'done' ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={cn(
                'text-sm',
                state === 'upcoming' ? 'text-muted-foreground' : 'font-medium text-foreground',
              )}
            >
              {step}
            </span>
            {index < steps.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
