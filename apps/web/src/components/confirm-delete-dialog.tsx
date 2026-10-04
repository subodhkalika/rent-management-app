import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What's being deleted, named — e.g. "123 Main St" or "Unit 4B". */
  itemName: string;
  /** What kind of thing it is — e.g. "property" or "unit". */
  itemKind: string;
  /** Extra consequence to mention, e.g. "Its 4 units will be deleted too." */
  consequence?: string;
  onConfirm: () => void;
  isPending?: boolean;
}

/** Shared confirm-delete dialog. Radix's AlertDialog already traps focus and closes
 *  on Escape, so this only needs to say, specifically, what is about to be deleted. */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  itemName,
  itemKind,
  consequence,
  onConfirm,
  isPending,
}: ConfirmDeleteDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {itemKind}?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes <strong className="font-medium text-foreground">{itemName}</strong>
            {consequence ? ` ${consequence}` : ''} This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isPending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
