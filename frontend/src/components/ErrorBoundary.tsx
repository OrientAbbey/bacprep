import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-4 text-center">
          <h1 className="font-serif-brand text-xl">Une erreur est survenue</h1>
          <p className="mt-2 max-w-md text-sm text-ink-soft">
            {this.state.error.message || "L'application a rencontré un problème inattendu."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 min-h-[44px] rounded-full bg-ink px-6 text-sm font-medium text-paper hover:opacity-90"
          >
            Recharger la page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
