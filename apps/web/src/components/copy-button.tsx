import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

interface CopyButtonProps {
  value: string;
  label?: string;
}

/** Copies `value` to the clipboard. Announces success both as a toast and
 *  via a local `aria-live` region, since a screen reader user needs to know
 *  the copy succeeded without having to go look for the button's icon. */
export function CopyButton({ value, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select and copy the text manually.');
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
        {copied ? <Check /> : <Copy />}
        {copied ? 'Copied' : label}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </>
  );
}
