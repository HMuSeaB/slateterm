import React from "react";

type Props = {
  paneTitle: string;
  onClose?: () => void;
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Contains a failure inside a single pane. Without this, any error thrown from a
 * pane subtree replaces the entire workspace with the global fatal screen.
 */
export default class PaneErrorBoundary extends React.Component<Props, State> {
  state: State = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("SlateTerm pane crash", this.props.paneTitle, error, info);
  }

  private handleReopen = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <section className="pane-failure" role="alert">
        <strong>{this.props.paneTitle} stopped responding</strong>
        <p>{this.state.error.message}</p>
        <details>
          <summary>Technical details</summary>
          <pre>{this.state.error.stack}</pre>
        </details>
        <div className="pane-failure-actions">
          <button type="button" onClick={this.handleReopen}>
            Reopen pane
          </button>
          {this.props.onClose && (
            <button type="button" className="is-danger" onClick={this.props.onClose}>
              Close pane
            </button>
          )}
        </div>
      </section>
    );
  }
}
