import { Component, type ReactNode } from "react";

/**
 * Keeps a render error inside its tab: the tab shows what went wrong and can
 * try again, while the other tabs, the sidebar and Claude keep working.
 */
export class TabBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash tab-crash">
        <h2>This tab hit an error</h2>
        <div style={{ color: "var(--text-2)", fontSize: 13 }}>Your other tabs are fine. Try again, or close this tab and reopen it.</div>
        <pre>{String(this.state.error.stack ?? this.state.error)}</pre>
        <button className="btn primary" onClick={() => { this.setState({ error: null }); }}>Try again</button>
      </div>
    );
  }
}
