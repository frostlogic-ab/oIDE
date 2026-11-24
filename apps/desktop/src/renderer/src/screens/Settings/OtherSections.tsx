import { useRef, useState } from 'react';
import type { Project, Settings } from '@oide/protocol';
import { ACCENT_OPTIONS, Kbd, cn } from '@oide/ui';
import { isMac, ipcErrorMessage, oide } from '../../lib/bridge';
import { ACTION_LABELS, DEFAULT_BINDINGS, comboLabel, keymap } from '../../lib/keymap';
import { useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { toast } from '../../stores/ui';
import type { LoadError } from './index';
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

/* ------------------------------------------------------------ Keyboard shortcuts */

export function KeysSection() {
  const mac = isMac();
  const bindings = keymap.getBindings();
  return (
    <>
      <H1>Keyboard shortcuts</H1>
      <Rd>Shortcuts work in the oIDE window only, never system-wide. Single keys are ignored while you type in a field.</Rd>
      <Sec>Shortcuts</Sec>
      {Object.keys({ ...DEFAULT_BINDINGS, ...bindings }).map((action) => {
        const combos = bindings[action] ?? DEFAULT_BINDINGS[action] ?? [];
        return (
          <Row key={action} title={ACTION_LABELS[action] ?? action}>
            {() => (
              <span className="flex gap-1.5">
                {combos.map((c) => (
                  <Kbd key={c} className="text-[12px] px-2 py-0.5">
                    {comboLabel(c, mac)}
                  </Kbd>
                ))}
              </span>
            )}
          </Row>
        );
      })}
    </>
  );
}

/* -------------------------------------------------------------------- Appearance */

export function AppearanceSection({ settings }: { settings: Settings }) {
  const current = settings.ui.accent.toUpperCase();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const pick = (i: number) => {
    const o = ACCENT_OPTIONS[(i + ACCENT_OPTIONS.length) % ACCENT_OPTIONS.length]!;
    void savePatch({ ui: { accent: o.value } });
    refs.current[ACCENT_OPTIONS.indexOf(o)]?.focus();
  };
  const idx = Math.max(0, ACCENT_OPTIONS.findIndex((o) => o.value.toUpperCase() === current));
  return (
    <>
      <H1>Appearance</H1>
      <Rd>oIDE uses one dark theme. Pick the accent for buttons, focus rings and the selected rail item.</Rd>
      <Row title="Accent colour" desc={`${ACCENT_OPTIONS[idx]!.label} · ${ACCENT_OPTIONS[idx]!.value}`}>
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
            {ACCENT_OPTIONS.map((o, i) => {
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

export function PrivacySection({ settings }: { settings: Settings }) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <H1>Privacy</H1>
      <Rd>oIDE never reads, stores or sends your Claude credentials. Prompts, code and paths stay on this computer.</Rd>
      <Sec>Telemetry</Sec>
      <Row title="Share anonymous usage statistics" desc="Off by default. Crash reports are opt-in and strip paths, prompts and code.">
        {({ titleId }) => (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent"
              aria-describedby={titleId}
              disabled={busy}
              checked={settings.ui.telemetry}
              onChange={async (e) => {
                setBusy(true);
                await savePatch({ ui: { telemetry: e.target.checked } });
                setBusy(false);
              }}
            />
            Share
          </label>
        )}
      </Row>
    </>
  );
}
