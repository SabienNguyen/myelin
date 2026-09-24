import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Contains a render crash to the subtree it wraps. Without one, a single malformed tool part or
 * a panel bug unmounts the whole React root and leaves a blank page with nothing to click.
 * A change of `resetKey` (a new route, another tab) tries the children again. */
export class ErrorBoundary extends Component<
  { fallback: ReactNode; label: string; resetKey?: string; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[myelin] ${this.props.label} failed to render:`, error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
