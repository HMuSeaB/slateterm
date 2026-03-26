import React from "react";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("SlateTerm render crash", error, info);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <main className="app-shell theme-graphite fatal-screen">
        <section className="fatal-card">
          <strong>SlateTerm hit a runtime error</strong>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
        </section>
      </main>
    );
  }
}

