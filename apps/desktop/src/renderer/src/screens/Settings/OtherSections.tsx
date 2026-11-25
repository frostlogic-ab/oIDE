import { useEffect, useMemo, useRef, useState } from 'react';
import { TELEMETRY_EVENT_NAMES, TELEMETRY_EVENTS, type Project, type Settings, type TelemetryStatus } from '@oide/protocol';
import { ACCENT_OPTIONS, Toggle, cn } from '@oide/ui';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { INCLUDED, NEVER_SENT } from '../../components/TelemetryConsent';
import { useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { toast } from '../../stores/ui';
import type { LoadError } from './index';
import { themeOptions } from '../../extensions/model';
import { useExtensions } from '../../extensions/store';
import { H1, Rd, Row, Sec, outlineBtn, savePatch } from './ui';

/* ---------------------------------------------------------------- Projects */

export function ProjectsSection({ projects, errors }: { projects: Project[]; errors: LoadError[] }) {
  const setTrust = async (p: Project, trusted: boolean) => {
    try {
      const updated = await oide.invoke('projects.trust', { projectId: p.id, trusted });
      useProjects.getState().set(useProjects.getState().list.map((x) => (x.id === p.id ? updated : x)));
    } catch (err) {
      toast(`Could not change trust for ${p.name}: ${ipcErrorMessage(err)}`, 'error');
    }
  };
  return (
    <>
      <H1>Projects</H1>
      <Rd>
        Each open project can carry its own settings in a <span className="font-mono">.oide/</span> folder (config, permissions, techniques, extensions). Untrusted projects ignore its setup command, allow rules
        and project MCP servers.
      </Rd>
      <Sec>Open projects</Sec>
      {projects.length === 0 && <Rd className="mt-3">No projects open.</Rd>}
      {projects.map((p) => {
        const errs = errors.filter((e) => e.projectId === p.id);
        return (
          <Row
            key={p.id}
            title={p.name}
            desc={
              <>
                <span className="font-mono text-[11.5px]">{p.path}</span>
                {errs.map((e) => (
                  <span key={e.file} className="block mt-1 text-warn">
                    <span className="font-mono">{e.file}</span>: {e.message}
                  </span>
                ))}
              </>
            }
          >
            {({ titleId }) => (
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" className="accent-accent" aria-describedby={titleId} checked={p.trusted} onChange={(e) => void setTrust(p, e.target.checked)} />
                Trusted
              </label>
            )}
          </Row>
        );
      })}
    </>
  );
}

/* ---------------------------------------------------------- Artifacts & claude.ai */

export function ArtifactsSection() {
  return (
    <>
      <H1>Artifacts &amp; claude.ai</H1>
      <Rd>Designs, docs and whiteboards that you and your agents share.</Rd>
      <Sec>Where they live</Sec>
      <Row title="Shared with the team" desc={<>Saved in the project's <span className="font-mono">.oide/artifacts/</span> folder, so they travel with the repo through git.</>}>
        {() => null}
      </Row>
      <Row title="Personal" desc="Saved in oIDE's app data on this computer only.">
        {() => null}
      </Row>
      <Sec>claude.ai</Sec>
      <Row
        title="Import from claude.ai"
        desc="Paste a claude.ai artifact link or pick an exported file. oIDE stores a copy, marked as imported. It is not synced: changes on either side stay there."
      >
        {() => (
          <button type="button" className={outlineBtn} onClick={() => navigate('artifacts', {})}>
            Open Artifacts
          </button>
        )}
      </Row>
      <Row title="Open in claude.ai" desc="Artifacts that came from claude.ai keep their link and open it in your browser. There is no public API for live sync yet.">
        {() => null}
      </Row>
    </>
  );
}

/* -------------------------------------------------------------------- Appearance */

export function AppearanceSection({ settings }: { settings: Settings }) {
  const current = settings.ui.accent.toUpperCase();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // Accents come from the themes extensions contribute (built in: Accent themes); the canvas's
  // four colours are the fallback when no theme extension is on.
  const installed = useExtensions((s) => s.installed);
  const themes = useMemo(() => themeOptions(installed), [installed]);
  const accents: ReadonlyArray<{ id: string; label: string; value: string }> = themes.length ? themes.map((t) => ({ id: t.key, label: t.label, value: t.value })) : ACCENT_OPTIONS;
  const pick = (i: number) => {
    const o = accents[(i + accents.length) % accents.length]!;
    void savePatch({ ui: { accent: o.value } });
    refs.current[accents.indexOf(o)]?.focus();
  };
  const idx = Math.max(0, accents.findIndex((o) => o.value.toUpperCase() === current));
  return (
    <>
      <H1>Appearance</H1>
      <Rd>oIDE uses one dark theme. Pick the accent for buttons, focus rings and the selected rail item.</Rd>
      <Row title="Accent colour" desc={`${accents[idx]!.label} · ${accents[idx]!.value}${themes[idx] ? ` · from ${themes[idx].extension}` : ''}`}>
        {({ titleId, descId }) => (
          <div
            role="radiogroup"
            aria-labelledby={titleId}
            aria-describedby={descId}
            className="flex gap-2"
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                pick(idx + 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                pick(idx - 1);
              }
            }}
          >
            {accents.map((o, i) => {
              const on = i === idx;
              return (
                <button
                  key={o.id}
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={o.label}
                  tabIndex={on ? 0 : -1}
                  onClick={() => pick(i)}
                  className={cn('w-8 h-8 rounded-full border-2 p-0 flex items-center justify-center', on ? 'border-ink' : 'border-transparent hover:border-line-hover')}
                >
                  <span className="w-6 h-6 rounded-full block" style={{ background: o.value }} />
                </button>
              );
            })}
          </div>
        )}
      </Row>
    </>
  );
}

/* ----------------------------------------------------------------------- Privacy */

const UNAVAILABLE: Record<string, string> = {
  'compiled-out': 'This build of oIDE has no telemetry endpoint, so it never sends anything.',
  'do-not-track': 'DO_NOT_TRACK is set in your environment, so oIDE sends nothing and the switches stay off.',
  env: 'OIDE_TELEMETRY=0 is set in your environment, so oIDE sends nothing and the switches stay off.',
  test: 'Telemetry is off in test runs.',
};

export function PrivacySection({ settings }: { settings: Settings }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [showSent, setShowSent] = useState(false);
  useEffect(() => {
    void invokeOr('telemetry.status', undefined, null).then(setStatus, () => undefined);
  }, [settings.privacy.usageAnalytics, settings.privacy.errorReports]);
  const available = status?.available ?? false;
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    await savePatch(patch);
    setBusy(false);
  };
  // Changing a switch here answers the first-run question too: it is not asked again.
  const setPrivacy = (key: 'usageAnalytics' | 'errorReports', on: boolean) => void save({ privacy: { [key]: on, consentAnswered: true } });
  return (
    <>
      <H1>Privacy</H1>
      <Rd>oIDE never reads, stores or sends your Claude credentials. Your code, prompts and paths stay on this computer.</Rd>
      <Sec>Usage and crash reports</Sec>
      <Rd className="mt-2 block">
        Both are off unless you turn them on. Sharing them helps us make oIDE better for you. Only how the app is used is sent, never your code, prompts or project information. Turning a switch off
        stops sending at once.
      </Rd>
      {status && !available && status.reason && (
        <Rd className="mt-2 block text-warn" id="telemetry-unavailable">
          {UNAVAILABLE[status.reason]}
        </Rd>
      )}
      <Row title="Share anonymous usage analytics" desc="Screens you open, features you use, counts, timings and performance, with a random install id. Never names, paths or content.">
        {({ titleId, descId }) => (
          <Toggle
            aria-labelledby={titleId}
            aria-describedby={descId}
            disabled={busy || !available}
            checked={available && settings.privacy.usageAnalytics}
            onChange={(on) => setPrivacy('usageAnalytics', on)}
          />
        )}
      </Row>
      <Row title="Send crash and error reports" desc="The kind of error, its message with paths, names, links and tokens removed, and where it happened in oIDE’s own code.">
        {({ titleId, descId }) => (
          <Toggle
            aria-labelledby={titleId}
            aria-describedby={descId}
            disabled={busy || !available}
            checked={available && settings.privacy.errorReports}
            onChange={(on) => setPrivacy('errorReports', on)}
          />
        )}
      </Row>
      <div className="py-3">
        <button type="button" className={outlineBtn} aria-expanded={showSent} aria-controls="telemetry-sent" onClick={() => setShowSent((v) => !v)}>
          {showSent ? 'Hide what’s sent' : 'See what’s sent'}
        </button>
        {showSent && <WhatIsSent />}
      </div>
      <Sec>On this computer</Sec>
      <Row
        title="Save crash reports on this computer"
        desc="Off by default. When on, oIDE keeps crash summaries on this computer only, with paths, prompts and code removed, for you to copy into a bug report. Nothing is uploaded by this switch. Turning it off deletes them."
      >
        {({ titleId, descId }) => (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent"
              aria-labelledby={titleId}
              aria-describedby={descId}
              disabled={busy}
              checked={settings.ui.crashReports}
              onChange={(e) => void save({ ui: { crashReports: e.target.checked } })}
            />
            Save
          </label>
        )}
      </Row>
    </>
  );
}

/** Everything telemetry can send, generated from the catalogue in packages/protocol/src/telemetry.ts. */
function WhatIsSent() {
  return (
    <div id="telemetry-sent" className="mt-3 p-3.5 rounded-lg border border-line-2 bg-panel flex flex-col gap-3 text-[12.5px] text-ink-2">
      <ul className="m-0 pl-4 flex flex-col gap-1.5">
        {INCLUDED.map((i) => (
          <li key={i.title}>
            <span className="text-ink">{i.title}:</span> {i.detail}
          </li>
        ))}
      </ul>
      <p className="m-0 text-ink-3">{NEVER_SENT}</p>
      <p className="m-0 text-ink-3">
        Screen views are sent as names such as <span className="font-mono">/wall</span> or <span className="font-mono">/settings/privacy</span>. These are all the events oIDE can send, with the only
        values they may carry:
      </p>
      <dl className="m-0 flex flex-col gap-2">
        {TELEMETRY_EVENT_NAMES.map((name) => (
          <div key={name}>
            <dt className="font-mono text-[12px] text-ink">{name}</dt>
            <dd className="m-0 text-ink-3">
              {TELEMETRY_EVENTS[name].question}
              {Object.keys(TELEMETRY_EVENTS[name].props.shape).length > 0 && (
                <span className="block font-mono text-[11.5px]">{Object.keys(TELEMETRY_EVENTS[name].props.shape).join(', ')}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
