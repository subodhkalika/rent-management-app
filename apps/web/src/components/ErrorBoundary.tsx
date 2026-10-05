import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Root-level safety net. React only catches render-phase throws with a
 * class component — there is no hook equivalent. Without this, any
 * unexpected throw anywhere in the tree (a null deref, a context used
 * outside its provider, ...) unmounts the whole app to a blank page with no
 * way back. For a tenant who can't tell whether their rent payment was
 * recorded, a blank page is the worst possible failure mode. This does not
 * fix the underlying bug — it only guarantees there is always a screen, and
 * a way off it, instead of silence.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.assign('/');
  };

  override render() {
    if (this.state.error) {
      return (
        <main className="grid min-h-screen place-items-center p-6">
          <div role="alert" aria-live="assertive" className="max-w-sm text-center">
            <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This screen hit an unexpected error. Nothing you did was lost on the server —
              reloading will take you back to a working page.
            </p>
            <Button className="mt-4" onClick={this.handleReload}>
              Reload
            </Button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
