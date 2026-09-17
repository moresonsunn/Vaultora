import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/** Isolates a panel crash so one bad view never blanks the whole app. */
export class ErrorBoundary extends React.Component<Props, { error: Error | null }> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(): void {
    /* error already captured in state */
  }
  render(): React.ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback || (
          <div className="empty-state">
            <p>Something went wrong in this panel.</p>
            <p className="muted small">{this.state.error.message}</p>
            <button
              className="btn sm"
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
            >
              Reload app
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
