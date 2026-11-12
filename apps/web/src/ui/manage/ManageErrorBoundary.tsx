import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * A bug in one Manage view must never blank the whole city: show what broke,
 * let the user retry or close, and keep everything else running.
 */
export class ManageErrorBoundary extends Component<
  { children: ReactNode; onClose(): void },
  State
> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error('Manage view crashed', error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="manage-panel" role="alert">
        <div className="manage-crash">
          <h2>This view hit a problem</h2>
          <p className="manage-error">{this.state.error.message}</p>
          <p className="manage-muted">
            Nothing was changed by this error. The rest of the app keeps running.
          </p>
          <div className="manage-toolbar">
            <button
              type="button"
              className="button-primary"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button type="button" onClick={this.props.onClose}>
              Close
            </button>
          </div>
        </div>
      </section>
    );
  }
}
