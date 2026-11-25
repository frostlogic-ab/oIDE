import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Logo } from '@oide/ui';
import { oide } from '../lib/bridge';
import { buildErrorReport, type ErrorReport } from '../lib/errorReport';

interface Props {
  /** Screen id, shown in the report. */
  screen: string;
  children: ReactNode;
}

interface State {
  error: unknown;
  report: ErrorReport | null;
  copied: boolean;
}

/**
 * One per screen (AppFrame). A render error in a screen shows this panel instead of a blank
 * window; the rail, header and other screens keep working, and agents (in main) are untouched.
 * "Try again" re-mounts the screen, "Reload window" reloads the page (stores rehydrate from main),
 * "Copy error report" copies a report without props, state, prompts or code (lib/errorReport.ts).
 */
export class ScreenErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, report: null, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const report = buildErrorReport({ screen: this.props.screen, error, componentStack: info.componentStack ?? null, platform: oide.platform });
    this.setState({ report });
    void oide
      .invoke('app.reportError', {
        screen: this.props.screen.slice(0, 60),
        name: report.name,
        message: report.message,
        stack: report.stack.join('\n'),
        componentStack: report.componentStack.join('\n'),
      })
      .catch(() => undefined);
  }

  override componentDidUpdate(prev: Props): void {
    // Navigating to another screen clears the error.
    if (prev.screen !== this.props.screen && this.state.error) this.reset();
  }

  reset = (): void => this.setState({ error: null, report: null, copied: false });

  copy = async (): Promise<void> => {
    if (!this.state.report) return;
    try {
      await navigator.clipboard.writeText(this.state.report.text);
      this.setState({ copied: true });
    } catch {
      this.setState({ copied: false });
    }
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const report = this.state.report;
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-6" data-testid="screen-error">
        <section role="alert" aria-labelledby="screen-error-title" className="max-w-[520px] w-full p-5 rounded-xl border border-line-2 bg-card flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <Logo size={24} />
            <h1 id="screen-error-title" className="m-0 text-[16px] font-semibold">
              This screen ran into a problem
            </h1>
          </div>
          <p className="m-0 text-[13px] text-ink-2 leading-normal">Your agents keep running in the background; nothing was lost. Try again, or reload the window.</p>
          {report && <p className="m-0 font-mono text-[12px] text-ink-3 break-words">{`${report.name}: ${report.message}`}</p>}
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" onClick={this.reset}>
              Try again
            </Button>
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Reload window
            </Button>
            <Button variant="ghost" onClick={() => void this.copy()} disabled={!report}>
              {this.state.copied ? 'Copied' : 'Copy error report'}
            </Button>
          </div>
          {report && (
            <details className="text-[12px] text-ink-3">
              <summary className="cursor-pointer">What the report contains</summary>
              <pre className="mt-2 p-2 rounded-md bg-panel border border-line font-mono text-[11.5px] whitespace-pre-wrap max-h-[200px] overflow-auto">{report.text}</pre>
              <span>No prompts, code, file paths or settings are included.</span>
            </details>
          )}
        </section>
      </div>
    );
  }
}
