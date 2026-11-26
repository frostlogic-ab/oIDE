import { useEffect, useId, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import type { AgentSummary } from '@oide/protocol';
import { Button, DiffStat, IconButton, LinkButton, Tooltip } from '@oide/ui';
import { invokeOr } from '../../../lib/bridge';
import { formatResetTime } from '../../../lib/format';
import { useShortcutLabel } from '../../../lib/useKeymap';
import { INTERRUPTED_PERMISSION_NOTE, isRunning } from '../../../stores/agents';
import { archiveAgent } from '../../../stores/archive';
import { navigate } from '../../../stores/router';
import { freshnessText, useMergePrediction } from '../../../stores/mergePrediction';
import { useSetting } from '../../../stores/settings';
import { AttachFileButton, AttachmentTray, useAttachments } from '../../../components/Attachments';
import { PrLink } from '../../../components/PrLink';
import { answerPermission, openPullRequest, pushToPullRequest, resumeAgent, sendReply, type PermissionChoice } from '../actions';
import { canArchive, interruptionText, parseActivity, permissionView, tileBodyKind } from '../logic';

/**
 * The black box in the middle of a tile. The canvas draws the prompt boxes 92px tall
 * (border-box) and the activity box 92px of content plus 8/10px padding (content-box, 108px
 * outer) so five 1.6-leading activity lines fit whole.
 */
const BOX = 'mx-3 bg-chrome rounded-md h-[92px] box-border overflow-hidden';
const ACTIVITY_BOX = 'mx-3 bg-chrome rounded-md h-[108px] box-border overflow-hidden';

/** The black box in the middle of a tile: activity, the permission prompt, the question, … */
export function TileBody({ agent }: { agent: AgentSummary }) {
  const kind = tileBodyKind(agent);
  switch (kind) {
    case 'permission': {
      const v = permissionView(agent.pendingPermission!, agent.subagents);
      return (
        <div className={`${BOX} p-2.5 flex flex-col gap-1.5`}>
          <span className="text-[12px] text-ink-2">
            {v.subagent ? (
              <>
                Subagent <span className="text-warn">{v.subagent}</span> {v.verb}
              </>
            ) : (
              <>{v.verb[0]!.toUpperCase() + v.verb.slice(1)}</>
            )}
          </span>
          <span className="font-mono text-[12px] text-warn truncate" title={v.target}>
            {v.target}
          </span>
          {v.note && <span className="text-[12px] text-ink-3 line-clamp-2">{v.note}</span>}
        </div>
      );
    }
    case 'interrupted': {
      const p = agent.interruptedPermission!;
      return (
        <div className={`${BOX} p-2.5 flex flex-col gap-1.5 text-[12px] leading-normal`} role="note" aria-label="Unanswered permission prompt">
          <span className="text-warn">{INTERRUPTED_PERMISSION_NOTE}</span>
          <span className="text-ink-3 truncate" title={p.summary ?? p.toolName}>
            It was asking to use <span className="font-mono text-ink-2">{p.toolName}</span>
            {p.summary ? `: ${p.summary}` : ''}
          </span>
        </div>
      );
    }
    case 'interrupted-run': {
      const lastLine = agent.activity.filter((l) => !/^(Thinking|Writing)…?$/.test(l.trim())).at(-1);
      return (
        <div className={`${BOX} p-2.5 flex flex-col gap-1.5 text-[12px] leading-normal`} role="note" aria-label="Interrupted">
          <span className="text-warn">{interruptionText(agent.interrupted!.reason)}</span>
          <span className="text-ink-3 line-clamp-2">
            {agent.resumeBlocked ?? (lastLine ? <>Last step: <span className="font-mono text-ink-2">{lastLine}</span></> : 'Resume continues the same session where it stopped.')}
          </span>
        </div>
      );
    }
    case 'question':
      return (
        <div className={`${BOX} p-2.5 text-[12px] text-ink-2 leading-normal`}>
          <p className="m-0 line-clamp-4">{agent.lastMessage ?? 'The agent finished its turn and is waiting for you.'}</p>
        </div>
      );
    case 'review':
      return (
        <div className={`${BOX} p-2.5 flex flex-col gap-1.5 text-[12px] text-ink-2`}>
          <span className="line-clamp-3">{agent.review?.summary ?? agent.lastMessage ?? 'Submitted for review.'}</span>
          <span className="flex items-center gap-2 min-w-0 text-[11.5px]">
            {agent.diff && <DiffStat mono files={agent.diff.files} additions={agent.diff.additions} deletions={agent.diff.deletions} className="text-ink-3 shrink-0" />}
            <MergeFreshness agent={agent} />
          </span>
        </div>
      );
    case 'queued':
      return <QueuedBody />;
    case 'rate-limited':
      return (
        <div className={`${BOX} p-2.5 flex flex-col gap-1.5 text-[12px] text-ink-2 leading-normal`}>
          <span>
            Paused by your plan's usage limit
            {agent.rateLimitResetAt ? (
              <>
                . Resets <span className="text-warn">{formatResetTime(agent.rateLimitResetAt)}</span>.
              </>
            ) : (
              '.'
            )}
          </span>
          <span className="text-ink-3">oIDE does not retry on its own. Resume when the limit resets.</span>
        </div>
      );
    case 'error':
      return (
        <div className={`${BOX} p-2.5 flex flex-col gap-1.5 text-[12px] leading-normal`}>
          <span className="text-bad">
            {agent.exitCode != null ? `The claude process exited with code ${agent.exitCode}.` : 'The agent stopped with an error.'}
          </span>
          {agent.error && <span className="font-mono text-[11.5px] text-ink-3 line-clamp-3 break-all">{agent.error}</span>}
        </div>
      );
    case 'activity':
      return <ActivityBody agent={agent} />;
  }
}

/** "Up to date with main" / "Behind main by 2 · would conflict": main's cached prediction, refreshed on git.changed. */
function MergeFreshness({ agent }: { agent: AgentSummary }) {
  const { prediction } = useMergePrediction(agent.id, agent.projectId, agent.status === 'ready-for-review' && Boolean(agent.branch));
  const text = freshnessText(prediction, { short: true });
  if (!text) return null;
  return (
    <span className={`truncate ${prediction?.status === 'conflicts' ? 'text-warn' : 'text-ink-3'}`} title={freshnessText(prediction)}>
      {text}
    </span>
  );
}

function QueuedBody() {
  const max = useSetting((s) => s.agents.maxRunning, 3);
  return (
    <div className={`${BOX} p-2.5 flex flex-col gap-1.5 text-[12px] text-ink-2 leading-normal opacity-80`}>
      <span>Waiting for a free slot.</span>
      <span className="text-ink-3">
        At most {max} agents run at once (Settings › Agents). This one starts when another finishes.
      </span>
    </div>
  );
}

function ActivityBody({ agent }: { agent: AgentSummary }) {
  const live = isRunning(agent);
  const lines = parseActivity(agent.activity.slice(-5), agent.subagents, live);
  return (
    <div className={`${ACTIVITY_BOX} px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-ink-code`} aria-label="Latest activity">
      {!lines.length && <div className="text-ink-3">{agent.status === 'starting' ? 'Starting claude…' : 'No activity yet'}</div>}
      {lines.map((l, i) => {
        if (l.kind === 'result')
          return (
            <div key={i} className="text-ink-3 truncate whitespace-pre">
              {'  ⎿ '}
              {l.text}
            </div>
          );
        if (l.kind === 'sub')
          return (
            <div key={i} className="truncate">
              <span className="text-ink-3">↳ {l.subagent}</span> {l.text && <Marker active={l.active} />} {l.text}
            </div>
          );
        return (
          <div key={i} className="truncate">
            <Marker active={l.active} /> {l.text}
            {l.additions != null && (
              <>
                {' '}
                <span className="text-ok">+{l.additions}</span> <span className="text-bad">−{l.deletions}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Marker({ active }: { active: boolean }) {
  return active ? (
    <span className="text-accent" aria-hidden="true">
      ◐
    </span>
  ) : (
    <span className="text-ok" aria-hidden="true">
      ●
    </span>
  );
}

// ---------- footer ----------

const FOOTER = 'flex items-center gap-1.5 px-3 py-2.5 mt-auto flex-wrap';

export function TileFooter({ agent, projectName, focused }: { agent: AgentSummary; projectName: string; focused: boolean }) {
  const kind = tileBodyKind(agent);
  const openFocus = (e: MouseEvent) => {
    e.preventDefault();
    navigate('focus', { agentId: agent.id });
  };
  const open = (tone: 'default' | 'warn' = 'default') => (
    <LinkButton
      href={`#focus/${agent.id}`}
      onClick={openFocus}
      variant={tone === 'warn' ? 'ghost' : 'secondary'}
      className={tone === 'warn' ? 'text-warn! hover:bg-warn-bg-2!' : undefined}
      aria-label={`Open ${agent.title}`}
    >
      Open
    </LinkButton>
  );

  switch (kind) {
    case 'permission':
      return <PermissionActions agent={agent} projectName={projectName} focused={focused} open={open('warn')} />;
    case 'question':
      return <ReplyBox agent={agent} />;
    case 'review':
      return (
        <div className={FOOTER}>
          <LinkButton
            href={`#review/${agent.id}`}
            variant="review"
            onClick={(e) => {
              e.preventDefault();
              navigate('review', { agentId: agent.id });
            }}
          >
            Review diff
          </LinkButton>
          {agent.pr ? <PrLink pr={agent.pr} /> : <OpenPrButton agent={agent} />}
          {agent.pr && (agent.pr.state === 'open' || agent.pr.state === 'draft') && <PushToPrButton agent={agent} number={agent.pr.number} />}
          <div className="flex-1" />
          <ArchiveButton agent={agent} />
        </div>
      );
    case 'rate-limited':
    case 'error':
      return (
        <div className={`${FOOTER} text-ink-3 text-[12px]`}>
          {kind === 'rate-limited' && agent.rateLimitResetAt ? <span>Resets {formatResetTime(agent.rateLimitResetAt)}</span> : agent.diff ? <Diff agent={agent} /> : null}
          <div className="flex-1" />
          <ArchiveButton agent={agent} />
          <ResumeButton agent={agent} />
          {open()}
        </div>
      );
    case 'interrupted-run':
      return (
        <div className={`${FOOTER} gap-2.5 text-ink-3 text-[12px]`}>
          {agent.diff ? <Diff agent={agent} /> : <span>No changes yet</span>}
          <div className="flex-1" />
          <ArchiveButton agent={agent} />
          <ResumeButton agent={agent} />
          {open()}
        </div>
      );
    default:
      return (
        <div className={`${FOOTER} gap-2.5 text-ink-3 text-[12px]`}>
          {kind === 'queued' ? <span>Queued</span> : agent.diff ? <Diff agent={agent} /> : <span>No changes yet</span>}
          <div className="flex-1" />
          {agent.pr && <PrLink pr={agent.pr} />}
          {(agent.status === 'paused' || agent.status === 'stopped' || agent.status === 'done') && <ArchiveButton agent={agent} />}
          {(agent.status === 'paused' || agent.status === 'stopped') && <ResumeButton agent={agent} />}
          {open()}
        </div>
      );
  }
}

function Diff({ agent }: { agent: AgentSummary }) {
  const d = agent.diff!;
  return <DiffStat files={d.files} additions={d.additions} deletions={d.deletions} />;
}

/** Archive (finished or stopped agents): off the Wall, into Wall › Archived. */
function ArchiveButton({ agent }: { agent: AgentSummary }) {
  const [busy, setBusy] = useState(false);
  if (!canArchive(agent)) return null;
  return (
    <IconButton
      icon="archive"
      aria-label={`Archive ${agent.title}`}
      title="Archive"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await archiveAgent(agent.id, agent.title);
        setBusy(false);
      }}
    />
  );
}

function ResumeButton({ agent }: { agent: AgentSummary }) {
  const [busy, setBusy] = useState(false);
  // Its worktree is gone (or it never had a session): Resume cannot work, so say why instead.
  if (agent.resumeBlocked)
    return (
      <span className="text-[12px] text-ink-3" title={agent.resumeBlocked}>
        Can't resume
      </span>
    );
  return (
    <Button
      disabled={busy}
      icon="play"
      onClick={async () => {
        setBusy(true);
        await resumeAgent(agent.id);
        setBusy(false);
      }}
    >
      Resume
    </Button>
  );
}

/** `git.prAvailable` per project, cached for the session (hidden when gh is missing or signed out). */
const prAvailability = new Map<string, Promise<{ available: boolean; reason?: string }>>();
function usePrAvailable(projectId: string): { available: boolean; reason?: string } {
  const [state, setState] = useState<{ available: boolean; reason?: string }>({ available: true });
  useEffect(() => {
    let cancelled = false;
    let p = prAvailability.get(projectId);
    if (!p) {
      p = invokeOr('git.prAvailable', { projectId }, { available: true }).catch(() => ({ available: true }));
      prAvailability.set(projectId, p);
    }
    void p.then((r) => !cancelled && setState(r));
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return state;
}

function OpenPrButton({ agent }: { agent: AgentSummary }) {
  const [busy, setBusy] = useState(false);
  const pr = usePrAvailable(agent.projectId);
  if (!pr.available) return null;
  return (
    <Button
      variant="review-outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await openPullRequest(agent.id);
        setBusy(false);
      }}
    >
      Open PR
    </Button>
  );
}

/** Follow-up work after the PR was opened goes up to that PR (main commits leftover files first). */
function PushToPrButton({ agent, number }: { agent: AgentSummary; number: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="review-outline"
      icon="arrow-up"
      disabled={busy}
      aria-label={`Push new changes to pull request #${number}`}
      title={`Push new changes to pull request #${number}`}
      onClick={async () => {
        setBusy(true);
        await pushToPullRequest(agent.id);
        setBusy(false);
      }}
    >
      {busy ? 'Pushing…' : 'Push'}
    </Button>
  );
}

const NO_ALWAYS_RULE = 'No rule can be saved for this request: allow it once or deny it';

function PermissionActions({ agent, projectName, focused, open }: { agent: AgentSummary; projectName: string; focused: boolean; open: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const allowKey = useShortcutLabel('permission.allow');
  const denyKey = useShortcutLabel('permission.deny');
  const req = agent.pendingPermission!;
  const answer = async (choice: PermissionChoice) => {
    setBusy(true);
    await answerPermission(agent.id, req.requestId, choice);
    setBusy(false);
  };
  const always = (
    <Button variant="warn-outline" disabled={busy || !req.suggestedRule} onClick={() => void answer('always')}>
      Always in {projectName}
    </Button>
  );
  return (
    <div className={FOOTER} role="group" aria-label={`Permission: ${req.summary}`}>
      <Button variant="warn" disabled={busy} kbd={focused ? allowKey : undefined} onClick={() => void answer('allow')}>
        Allow once
      </Button>
      <Tooltip content={req.suggestedRule ? `Allow and save ${req.suggestedRule} for ${projectName}` : NO_ALWAYS_RULE}>{always}</Tooltip>
      <Button variant="warn-outline" disabled={busy} kbd={focused ? denyKey : undefined} onClick={() => void answer('deny')}>
        Deny
      </Button>
      <div className="flex-1" />
      {open}
    </div>
  );
}

/** The question tile's reply: text plus pasted screenshots, dropped files or Attach file (shown as one compact row). */
function ReplyBox({ agent }: { agent: AgentSummary }) {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const atts = useAttachments();
  const ready = (text.trim() !== '' || atts.items.length > 0) && !atts.busy;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    if (await sendReply(agent.id, text, atts.attachments)) {
      setText('');
      atts.clear();
    }
    setBusy(false);
  };
  return (
    <form className={FOOTER} onSubmit={submit} {...atts.dropProps}>
      <AttachmentTray state={atts} compact className="w-full" />
      <label htmlFor={id} className="sr-only">
        Reply to {agent.title}
      </label>
      <input
        id={id}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={atts.onPaste}
        placeholder={atts.dragging ? 'Drop to attach' : 'Reply…'}
        autoComplete="off"
        className={`flex-1 min-w-0 h-7 px-2.5 rounded-sm border bg-chrome text-ink text-[12px] outline-none focus:border-warn placeholder:text-ink-3 ${atts.dragging ? 'border-warn' : 'border-warn-line'}`}
      />
      <AttachFileButton state={atts} size={28} />
      <Button type="submit" variant="warn" disabled={busy || !ready}>
        Send
      </Button>
    </form>
  );
}
