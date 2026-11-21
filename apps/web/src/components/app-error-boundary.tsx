import { Component, type ReactNode } from 'react';
import { LocalizedText } from '@/lib/i18n/text';
import '@/styles/salem-polish.css';
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="salem-app-error" role="alert">
          <h1>
            <LocalizedText message="This page couldn’t load" />
          </h1>
          <p>
            <LocalizedText message="Reload to reconnect. Previously confirmed requests remain saved on the server; check their status before submitting another." />
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            <LocalizedText message="Reload page" />
          </button>
          <a href="/">
            <LocalizedText message="Return home" />
          </a>
        </main>
      );
    return this.props.children;
  }
}
