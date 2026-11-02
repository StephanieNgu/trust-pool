import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Keeps an unexpected render failure from leaving the entire application blank. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, details: ErrorInfo) {
    console.error("TrustPool frontend crashed", error, details.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-error" role="alert">
      <div>
        <span className="eyebrow">APPLICATION RECOVERY</span>
        <h1>TrustPool could not display this page.</h1>
        <p>Your wallet transaction and on-chain data are not changed. Try reopening the app; if the problem continues, reload the local frontend.</p>
        <div>
          <button className="primary" type="button" onClick={() => this.setState({ error: null })}>Reopen application</button>
          <button className="text-button" type="button" onClick={() => window.location.reload()}>Reload page</button>
        </div>
        {import.meta.env.DEV && <pre>{this.state.error.message}</pre>}
      </div>
    </main>;
  }
}
