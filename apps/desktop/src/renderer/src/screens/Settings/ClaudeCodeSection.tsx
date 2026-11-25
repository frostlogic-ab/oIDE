import { useEffect, useState } from 'react';
import { TESTED_CLI_RANGE, type PermissionMode, type Settings } from '@oide/protocol';
import { cn } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { cliHealth, useCli } from '../../stores/cli';
import { toast } from '../../stores/ui';
import { H1, Rd, Row, Sec, describedBy, inp, inpSm, outlineBtn, savePatch } from './ui';

const MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: 'auto', label: 'Auto: approves safe actions, pauses on risky ones' },
  { value: 'default', label: 'Manual: asks before every edit' },
  { value: 'acceptEdits', label: 'Edit automatically' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];

export function ClaudeCodeSection({ settings, goModels }: { settings: Settings; goModels: () => void }) {
  const info = useCli((s) => s.info);
  const detected = useCli((s) => s.detected);
  const health = cliHealth(info, detected);
  const [checking, setChecking] = useState(false);

  const signIn = async () => {
    try {
      await useCli.getState().openSignIn();
      toast('A terminal running claude opened. Sign in there; oIDE never sees your credentials.', 'info');
    } catch (err) {
      toast(`Could not open the sign-in terminal: ${ipcErrorMessage(err)}`, 'error');
    }
  };
  const check = async () => {
    setChecking(true);
    try {
      await useCli.getState().detect();
    } finally {
      setChecking(false);
    }
  };

  const tone = health === 'connected' || health === 'untested' ? 'ok' : health === 'missing' ? 'bad' : 'warn';
  const title =
    health === 'connected'
      ? // Sign-in is learned from the first agent's init or an auth error; until then do not claim it.
        info?.signedIn === 'yes'
        ? 'CLI found and signed in'
        : 'CLI found'
      : health === 'untested'
        ? 'CLI found, version not tested with oIDE'
        : health === 'sign-in'
          ? 'CLI found, not signed in'
          : health === 'missing'
            ? 'Claude Code CLI not found'
            : health === 'checking'
              ? 'Looking for the CLI…'
              : 'CLI found, sign-in state unknown';

  const allowBypass = settings.claude.allowBypass;
  const modes = MODE_OPTIONS.filter((m) => m.value !== 'bypassPermissions' || allowBypass || settings.claude.defaultMode === 'bypassPermissions');

  return (
    <>
      <H1>Claude Code</H1>
      <Rd>oIDE runs your installed Claude Code CLI for every agent. It uses your own sign-in and plan.</Rd>

      <div
        role="status"
        className={cn(
          'flex items-center gap-3 mt-[18px] p-3.5 rounded-xl border flex-wrap',
          tone === 'ok' && 'border-ok-line bg-ok-bg-2',
          tone === 'warn' && 'border-warn-line bg-warn-bg',
          tone === 'bad' && 'border-bad-line bg-bad-bg',
        )}
      >
        <span aria-hidden="true" className={cn('w-[9px] h-[9px] rounded-full', tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-bad')} />
        <div className="flex-1 min-w-[240px] flex flex-col gap-0.5">
          <span className={cn('font-semibold', tone === 'ok' ? 'text-[#C9E9DA]' : tone === 'warn' ? 'text-warn' : 'text-bad-bright')}>{title}</span>
          <span className={cn('font-mono text-[12px]', tone === 'ok' ? 'text-[#A8C9BA]' : 'text-ink-3')}>
            {info?.found ? `${info.path ?? 'claude'} · ${info.version ?? 'unknown version'}` : 'Install Claude Code, or set its path below.'}
          </span>
          <span className={cn('text-[11.5px]', tone === 'ok' ? 'text-[#A8C9BA]' : 'text-ink-3')}>
            Tested with {TESTED_CLI_RANGE.min} – {TESTED_CLI_RANGE.max}
          </span>
        </div>
        {health === 'sign-in' && (
          <button type="button" onClick={signIn} className="h-[30px] px-3 rounded-[7px] border-0 bg-accent text-on-accent font-semibold text-[12.5px]">
            Sign in
          </button>
        )}
        <button
          type="button"
          onClick={check}
          disabled={checking}
          className={cn(
            'h-[30px] px-3 rounded-[7px] border bg-transparent text-[12.5px] disabled:opacity-50',
            tone === 'ok' ? 'border-ok-line text-[#C9E9DA]' : tone === 'warn' ? 'border-warn-line text-warn' : 'border-bad-line text-bad-bright',
          )}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>

      <Sec>Account</Sec>
      <Row title="Plan" desc="Read from the CLI when it reports it. Sign-in happens in a terminal running claude, through Anthropic's own flow.">
        {() =>
          info?.signedIn === 'yes' ? (
            <span>Signed in</span>
          ) : (
            <button type="button" className={outlineBtn} onClick={signIn}>
              Sign in
            </button>
          )
        }
      </Row>
      <Row title="CLI path" desc="Leave empty to find claude on your PATH.">
        {({ titleId, descId }) => <CliPathInput value={settings.claude.cliPath ?? ''} labelledBy={titleId} describedById={descId} />}
      </Row>

      <Sec>Defaults for new agents</Sec>
      <Row title="Models" desc="Focus presets and the default focus live in their own section.">
        {() => (
          <button type="button" onClick={goModels} className={cn(outlineBtn, 'h-8 rounded-md')}>
            Open Models settings
          </button>
        )}
      </Row>
      <Row title="Default mode" desc="The permission mode new agents start in. Change it on a running agent from the mode menu in its header, or with Shift + Tab.">
        {({ titleId, descId }) => (
          <select
            aria-labelledby={titleId}
            aria-describedby={descId}
            className={inp}
            value={settings.claude.defaultMode}
            onChange={(e) => void savePatch({ claude: { defaultMode: e.target.value } })}
          >
            {modes.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </Row>
      <Row
        title="Allow Bypass permissions"
        desc={
          <>
            Shows Bypass in the mode list. Agents in this mode never ask before running commands, so oIDE keeps them in a worktree.
            {allowBypass && (
              <span className="block mt-1 text-warn">Bypass agents can run any command without asking. Only use it for work you would let run unattended.</span>
            )}
          </>
        }
      >
        {({ titleId, descId }) => (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent"
              aria-describedby={describedBy(titleId, descId)}
              checked={allowBypass}
              onChange={(e) => {
                const on = e.target.checked;
                const patch: Record<string, unknown> = { allowBypass: on };
                if (!on && settings.claude.defaultMode === 'bypassPermissions') patch.defaultMode = 'auto';
                void savePatch({ claude: patch });
              }}
            />
            Allowed
          </label>
        )}
      </Row>
      <Row title="Extra CLI flags" desc="Added to every session.">
        {({ titleId, descId }) => <ExtraFlagsInput value={settings.claude.extraFlags} labelledBy={titleId} describedById={descId} />}
      </Row>
    </>
  );
}

function CliPathInput({ value, labelledBy, describedById }: { value: string; labelledBy: string; describedById?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v === value) return;
    void savePatch({ claude: { cliPath: v ? v : null } });
  };
  // SEC-29: a typed path asks for a native confirmation in main; one chosen here does not.
  const browse = async () => {
    try {
      const p = await oide.invoke('dialog.pickCli', undefined);
      if (p) void savePatch({ claude: { cliPath: p } });
    } catch (err) {
      toast(`Could not open the file picker: ${ipcErrorMessage(err)}`, 'error');
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="text"
        aria-labelledby={labelledBy}
        aria-describedby={describedById}
        className={cn(inpSm, 'w-[200px]')}
        placeholder="auto-detect"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <button type="button" className={outlineBtn} onClick={() => void browse()}>
        Browse…
      </button>
    </span>
  );
}

function ExtraFlagsInput({ value, labelledBy, describedById }: { value: string; labelledBy: string; describedById?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() === value) return;
    void savePatch({ claude: { extraFlags: draft.trim() } });
  };
  return (
    <input
      type="text"
      aria-labelledby={labelledBy}
      aria-describedby={describedById}
      className={cn(inpSm, 'w-[282px]')}
      placeholder="--verbose"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}
