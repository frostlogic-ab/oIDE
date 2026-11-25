import { useEffect, useRef, useState } from 'react';
import type { TelemetryStatus } from '@oide/protocol';
import { Button, Dialog, Logo } from '@oide/ui';
import { invokeOr, oide } from '../lib/bridge';
import { useSettings } from '../stores/settings';

/** Shown this long after the window is ready, so it never races the first paint or a native dialog. */
export const CONSENT_DELAY_MS = 1200;

/** The categories the first-run question and Settings › Privacy list ("What's included"). */
export const INCLUDED: Array<{ title: string; detail: string }> = [
  {
    title: 'Screens you open',
    detail: 'Agents, Focus, Files, Settings › Privacy… as names only, never what is on them.',
  },
  {
    title: 'Features you use',
    detail:
      'For example: an agent was started (model family, effort, permission mode), a permission was answered, a search ran, a setting changed (which one, never its value).',
  },
  {
    title: 'Counts and timings',
    detail:
      'Start-up time, how long agent runs take, how many agents, subagents and tokens, in coarse ranges.',
  },
  { title: 'Performance', detail: 'Render and response times, memory use in coarse ranges.' },
  {
    title: 'Crash and error reports',
    detail:
      'The kind of error, its message with paths, names, links and tokens removed, and where it happened in oIDE’s own code.',
  },
  {
    title: 'Your setup',
    detail:
      'oIDE, Claude Code CLI and Electron versions, operating system, language, screen size range, and a random install id made when you agree.',
  },
];

export const NEVER_SENT =
  'Never sent: your code, prompts or agent output, file names or paths, project, repository or branch names, commit messages, artifacts, settings values, the links you open, or anything about your Claude account.';

/**
 * The first-run question (ADR 0011). Appears once the window is ready, when main says it should
 * (not answered yet, and closed without a choice on fewer than two launches). Closing it (Esc, the
 * scrim) counts as "not now": it may come back on the next launch, at most twice in all.
 */
export function TelemetryConsent() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const loaded = useSettings((s) => !!s.settings);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void invokeOr('telemetry.status', undefined, null as TelemetryStatus | null).then(
        (s) => {
          if (cancelled || !s?.showPrompt) return;
          setOpen(true);
          void oide.invoke('telemetry.consent', { choice: 'shown' }).catch(() => undefined);
        },
        () => undefined,
      );
    }, CONSENT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [loaded]);

  const answer = async (choice: 'accept' | 'decline' | 'later') => {
    setBusy(true);
    try {
      await oide.invoke('telemetry.consent', { choice });
    } catch {
      /* main decides; closing is always fine */
    }
    setBusy(false);
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onClose={() => void answer('later')}
      title="Help make oIDE better for you"
      icon={<Logo size={28} />}
      width={520}
      initialFocus={primary}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => void answer('decline')}>
            No thanks
          </Button>
          <Button ref={primary} variant="primary" disabled={busy} onClick={() => void answer('accept')}>
            Share usage and crash reports
          </Button>
        </>
      }
    >
      <div
        className="flex flex-col gap-3 text-[13px] text-ink-2 leading-[1.5]"
        data-testid="telemetry-consent"
      >
        <p className="m-0">
          oIDE gets better when we can see how it is really used and where it breaks. Sharing anonymous usage
          and crash reports is the most helpful thing you can do to make it work better for you.
        </p>
        <p className="m-0">
          <span className="text-ink font-semibold">
            No personal data, code, prompts or project information is ever sent
          </span>
          , only how the app is used.
        </p>
        <details className="rounded-lg border border-line-2 bg-panel px-3 py-2">
          <summary className="cursor-pointer text-ink text-[12.5px] font-semibold">What’s included</summary>
          <ul className="m-0 mt-2 pl-4 flex flex-col gap-1.5 text-[12.5px]">
            {INCLUDED.map((i) => (
              <li key={i.title}>
                <span className="text-ink">{i.title}:</span> {i.detail}
              </li>
            ))}
          </ul>
          <p className="m-0 mt-2 text-[12px] text-ink-3">{NEVER_SENT}</p>
        </details>
        <p className="m-0 text-[12px] text-ink-3">You can change this any time in Settings › Privacy.</p>
      </div>
    </Dialog>
  );
}
