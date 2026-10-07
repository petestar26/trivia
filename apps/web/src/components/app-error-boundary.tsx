import { Component, type ReactNode } from 'react';
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="payments-page" role="alert">
          <h1>This page couldn’t load</h1>
          <p>
            Reload to reconnect. Previously confirmed requests remain saved on the server; check
            their status before submitting another.
          </p>
          <button onClick={() => window.location.reload()}>Reload page</button>
          <a href="/">Return home</a>
        </main>
      );
    return this.props.children;
  }
}
