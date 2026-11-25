/**
 * Transcript row components (Focus.dc.html). Each row is memoized on its `key` + `v` (see
 * model/transcript.ts) and the shared context object, so a new event re-renders only the rows it
 * changed, and partial deltas re-render nothing here (see Streaming.tsx).
 */
import { memo, type ReactNode } from 'react';
import type { AgentEvent, MessageAttachment, SubagentInfo } from '@oide/protocol';
import { Button, Icon, subagentStatusMeta } from '@oide/ui';
import { MessageAttachments } from '../../../components/Attachments';
import { formatDuration, formatResetTime, formatTokens } from '../../../lib/format';
import { modelEffort, routeLabel, subagentStatusText, tokenCount } from '../model/focus';
import {
  subagentFiles,
  subagentSteps,
  toolDiff,
  toolLineLabel,
  toolMeta,
  type DiffLine,
  type StepState,
  type ToolLine,
  type TranscriptRow,
} from '../model/transcript';
import { useExpanded } from '../model/ui';
import { Markdown } from './Markdown';

export interface RowContext {
  agentId: string;
  subagents: Readonly<Record<string, SubagentInfo>>;
  subEvents: ReadonlyMap<string, AgentEvent[]>;
  /** Tool use id of the pending permission prompt, when the CLI reported it. */
  pendingToolUseId?: string;
  now: number;
  onOpenSubagent(id: string): void;
  onOpenReview(): void;
}

/** Rows only the subagent view has: the info banner + task bubble, and the closing note. */
export type ViewRow =
  | TranscriptRow
  | { kind: 'sub-intro'; key: string; seq: number; v: number; task: string }
  | { kind: 'sub-outro'; key: string; seq: number; v: number; done: boolean; report?: string };

export const RowView = memo(
  function RowView({ row, ctx }: { row: ViewRow; ctx: RowContext }) {
    switch (row.kind) {
      case 'user':
        return row.origin === 'oide' ? <OideMessage text={row.text} /> : <UserBubble text={row.text} attachments={row.attachments} />;
      case 'assistant':
        return <Markdown text={row.text} />;
      case 'thinking':
        return <Thinking rowKey={row.key} text={row.text} />;
      case 'tools':
        return <ToolCard lines={row.lines} ctx={ctx} />;
      case 'subagent':
        return <SubagentCard row={row} ctx={ctx} />;
      case 'notice':
        return <Notice tone={row.tone}>{row.text}</Notice>;
      case 'result':
        return <ResultLine row={row} />;
      case 'error':
        return (
          <Callout tone="bad" icon="alert-circle" title={row.code === 'auth' ? 'Signed out of Claude Code CLI' : 'The agent hit an error'}>
            {row.message}
          </Callout>
        );
      case 'rate-limit':
        return (
          <Callout tone="warn" icon="warning" title="Paused by plan limit">
            {row.message}
            {row.resetAt ? `. Resets ${formatResetTime(row.resetAt)}.` : '.'} oIDE does not retry on its own; resume the agent after the reset.
          </Callout>
        );
      case 'review':
        return <ReviewCard summary={row.summary} checks={row.checks} onOpen={ctx.onOpenReview} />;
      case 'sub-intro':
        return <SubIntro task={row.task} />;
      case 'sub-outro':
        return row.done && row.report ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-ink-3">Report to the lead agent</span>
            <div className="px-3.5 py-2.5 rounded-[10px] border border-line-2 bg-card text-[12.5px]">
              <Markdown text={row.report} />
            </div>
          </div>
        ) : (
          <span className="text-[12px] text-ink-3">When it finishes, its report appears in the lead agent's transcript.</span>
        );
    }
  },
  (a, b) => a.row.key === b.row.key && a.row.v === b.row.v && a.ctx === b.ctx,
);

function UserBubble({ text, attachments }: { text: string; attachments?: readonly MessageAttachment[] }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachments?.length ? (
        <div className="max-w-[80%]">
          <MessageAttachments attachments={attachments} />
        </div>
      ) : null}
      <div className="max-w-[80%] px-3.5 py-2.5 bg-selected rounded-[12px_12px_4px_12px] leading-[1.5] text-ink whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}

/** A message oIDE wrote to the agent (merge conflicts), plainly marked so it is never read as the user's. */
function OideMessage({ text }: { text: string }) {
  return (
    <div className="self-end max-w-[80%] flex flex-col gap-1" role="note" aria-label="Message sent by oIDE">
      <span className="self-end flex items-center gap-1 text-[11px] text-ink-3">
        <Icon name="branch" size={12} />
        Sent by oIDE
      </span>
      <div className="px-3.5 py-2.5 bg-panel border border-line-3 rounded-[12px_12px_4px_12px] leading-[1.5] text-ink-2 text-[12.5px] whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}

function SubIntro({ task }: { task: string }) {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex gap-2.5 items-start px-3 py-2.5 rounded-[10px] border border-line-2 bg-panel text-[12.5px] text-ink-2 leading-[1.5]">
        <Icon name="info" size={16} className="text-ink-3 mt-px" />
        <span>A subagent works on one task from the lead agent and reports back to it. To steer this one, message the lead agent below.</span>
      </div>
      <div className="self-end max-w-[80%] flex flex-col gap-1">
        <span className="self-end text-[11px] text-ink-3">Task from the lead agent</span>
        <div className="px-3.5 py-2.5 bg-selected rounded-[12px_12px_4px_12px] leading-[1.5] text-ink whitespace-pre-wrap break-words">{task || 'No task text was reported.'}</div>
      </div>
    </div>
  );
}

function Thinking({ rowKey, text }: { rowKey: string; text: string }) {
  const [open, toggle] = useExpanded(`think:${rowKey}`);
  const has = text.trim() !== '' && text.trim() !== 'Thinking…';
  if (!has) return <span className="text-[12px] text-ink-3 italic">Thinking…</span>;
  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" aria-expanded={open} onClick={toggle} className="self-start flex items-center gap-1.5 border-0 bg-transparent p-0 text-[12px] text-ink-3 hover:text-ink-2">
        <span aria-hidden="true" className="w-2.5 text-[11px]">
          {open ? '▾' : '▸'}
        </span>
        Thinking
      </button>
      {open && <div className="pl-4 border-l border-line-3 text-[12px] leading-[1.55] text-ink-3 whitespace-pre-wrap">{text}</div>}
    </div>
  );
}

const DOT: Record<StepState, { glyph: string; color: string }> = {
  done: { glyph: '●', color: 'var(--color-ok)' },
  run: { glyph: '◐', color: 'var(--color-accent)' },
  need: { glyph: '●', color: 'var(--color-warn)' },
  error: { glyph: '●', color: 'var(--color-bad)' },
};

function lineState(line: ToolLine, ctx: RowContext): StepState {
  const c = line.calls[line.calls.length - 1]!;
  if (ctx.pendingToolUseId && line.calls.some((x) => x.id === ctx.pendingToolUseId)) return 'need';
  if (line.calls.some((x) => x.result?.isError)) return 'error';
  if (!c.result) return 'run';
  return 'done';
}

function ToolCard({ lines, ctx }: { lines: ToolLine[]; ctx: RowContext }) {
  return (
    <div className="flex flex-col border border-line-2 rounded-[10px] overflow-hidden bg-card">
      {lines.map((line, i) => (
        <ToolLineView key={line.key} line={line} first={i === 0} ctx={ctx} />
      ))}
    </div>
  );
}

const DIFF_PREVIEW = 12;

function ToolLineView({ line, first, ctx }: { line: ToolLine; first: boolean; ctx: RowContext }) {
  const call = line.calls[0]!;
  const [open, toggle] = useExpanded(`out:${line.key}`);
  const [allDiff, toggleDiff] = useExpanded(`diff:${line.key}`);
  const meta = toolMeta(line);
  const state = lineState(line, ctx);
  const diff = line.calls.length === 1 ? toolDiff(call.name, call.input) : null;
  const output = line.calls
    .map((c) => (c.result ? (line.calls.length > 1 ? `${toolLineLabel({ key: c.id, calls: [c] })}\n${c.result.content}` : c.result.content) : ''))
    .filter(Boolean)
    .join('\n\n');
  const canExpand = output.trim() !== '';
  const label = toolLineLabel(line);
  return (
    <>
      <button
        type="button"
        aria-expanded={canExpand ? open : undefined}
        onClick={canExpand ? toggle : undefined}
        aria-label={`${label}${meta.text ? `, ${meta.text}` : ''}${state === 'need' ? ', waiting for your permission' : state === 'run' ? ', running' : ''}`}
        className={`w-full flex items-center gap-2 px-3 py-[7px] border-0 bg-transparent font-mono text-[12px] text-ink-code text-left ${first ? '' : 'border-t border-solid border-line'} ${canExpand ? 'hover:bg-raised cursor-pointer' : 'cursor-default'}`}
      >
        <span aria-hidden="true" style={{ color: DOT[state].color }}>
          {DOT[state].glyph}
        </span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        {meta.tone === 'diff' ? (
          <span className="shrink-0">
            {meta.additions ? <span className="text-ok">+{meta.additions}</span> : null}
            {meta.additions && meta.deletions ? ' ' : null}
            {meta.deletions ? <span className="text-bad">−{meta.deletions}</span> : null}
          </span>
        ) : state === 'need' ? (
          <span className="shrink-0 text-warn text-[11px]">waiting for you</span>
        ) : meta.text ? (
          <span className={`shrink-0 max-w-[45%] truncate text-[11px] ${meta.tone === 'bad' ? 'text-bad' : 'text-ink-3'}`}>{meta.text}</span>
        ) : null}
      </button>
      {diff && diff.length > 0 && <DiffBlock lines={diff} all={allDiff} onToggle={toggleDiff} preview={call.name === 'Write' ? 6 : DIFF_PREVIEW} />}
      {open && canExpand && (
        <pre className="m-0 max-h-[240px] overflow-auto px-3 py-2 border-t border-line bg-chrome font-mono text-[11.5px] leading-[1.6] text-ink-3 whitespace-pre-wrap break-words">
          {output.length > 20_000 ? `${output.slice(0, 20_000)}\n… ${output.length - 20_000} more characters` : output}
        </pre>
      )}
    </>
  );
}

function DiffBlock({ lines, all, onToggle, preview }: { lines: DiffLine[]; all: boolean; onToggle: () => void; preview: number }) {
  const shown = all ? lines : lines.slice(0, preview);
  return (
    <div className="border-t border-line font-mono text-[11.5px] leading-[1.7] bg-chrome" aria-label="Changes">
      {shown.map((l, i) => (
        <div
          key={i}
          className={`px-3 whitespace-pre-wrap break-all ${l.t === '+' ? 'bg-ok-bg text-ok-bright' : l.t === '-' ? 'bg-bad-bg text-bad-bright' : 'text-ink-3'}`}
        >
          <span aria-hidden="true">{l.t === ' ' ? '  ' : `${l.t} `}</span>
          <span className="sr-only">{l.t === '+' ? 'added: ' : l.t === '-' ? 'removed: ' : ''}</span>
          {l.s}
        </div>
      ))}
      {lines.length > preview && (
        <button type="button" onClick={onToggle} className="w-full px-3 py-1 border-0 border-t border-solid border-line bg-transparent text-left font-sans text-[11.5px] text-link hover:text-link-hover">
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function SubagentCard({ row, ctx }: { row: Extract<TranscriptRow, { kind: 'subagent' }>; ctx: RowContext }) {
  const info = ctx.subagents[row.toolUseId];
  const status = info?.status ?? (row.report ? (row.report.isError ? 'error' : 'done') : 'queued');
  const [open, toggle] = useExpanded(`sub:${row.toolUseId}`, status === 'running');
  const events = ctx.subEvents.get(row.toolUseId) ?? EMPTY;
  const report = info?.report ?? row.report?.content;
  const steps = subagentSteps(events, { status, report, pendingToolUseId: status === 'needs-permission' ? ctx.pendingToolUseId : undefined });
  const meta = subagentStatusMeta(status);
  const name = info?.name ?? row.description;
  const latest = steps[steps.length - 1]?.text ?? (status === 'queued' ? 'Waiting to start' : 'Starting…');
  const sub: SubagentInfo = info ?? { id: row.toolUseId, agentId: ctx.agentId, name, task: row.prompt, status, subagentType: row.subagentType };
  return (
    <div className={`flex flex-col border rounded-[10px] overflow-hidden bg-card ${status === 'needs-permission' ? 'border-warn-line' : 'border-line-2'}`}>
      {/* One row at any width: nothing wraps mid-phrase; "routed as" gives way first (and drops
          below 700px of session width), then the name truncates. */}
      <div className="flex items-center gap-2 py-2 pl-1.5 pr-2.5 min-w-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex-1 min-w-0 flex items-center gap-2 border-0 bg-transparent px-1 py-0.5 text-ink text-left text-[12.5px] whitespace-nowrap overflow-hidden"
        >
          <span aria-hidden="true" className="text-ink-3 w-2.5 text-[11px] shrink-0">
            {open ? '▾' : '▸'}
          </span>
          <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: meta.color }} />
          <span className="text-[11px] text-ink-3 shrink-0 @max-[700px]:sr-only">Subagent</span>
          <span className="font-semibold min-w-[4ch] truncate" title={name}>
            {name}
          </span>
          <span className="font-mono text-[10.5px] px-1.5 py-px rounded-[5px] bg-selected text-ink-2 shrink-0">{modelEffort(sub)}</span>
          <span className="text-[11.5px] text-ink-3 min-w-0 truncate shrink-[8] @max-[700px]:hidden">routed as {routeLabel(sub)}</span>
        </button>
        <span className="text-[11.5px] whitespace-nowrap shrink-0" style={{ color: meta.color }}>
          {subagentStatusText(sub, ctx.now)}
        </span>
        <Button size={28} className="!h-[26px] !px-[9px] !text-[11.5px] shrink-0" onClick={() => ctx.onOpenSubagent(row.toolUseId)} aria-label={`Open subagent ${name}`}>
          Open
        </Button>
      </div>
      {!open ? (
        <div className="font-mono pl-[34px] pr-3 pb-[9px] text-[11.5px] text-ink-3 truncate">{latest}</div>
      ) : (
        <div className="flex flex-col border-t border-line bg-panel">
          {steps.length === 0 && <div className="font-mono py-1.5 pl-[34px] pr-3 text-[11.5px] text-ink-3">{status === 'queued' ? 'Waiting to start' : 'No tool calls yet'}</div>}
          {steps.map((st) => (
            <div key={st.key} className="font-mono flex items-center gap-2 py-1.5 pl-[34px] pr-3 text-[11.5px] text-ink-code">
              <span aria-hidden="true" style={{ color: DOT[st.state].color }}>
                {DOT[st.state].glyph}
              </span>
              <span className="flex-1 min-w-0 truncate">{st.text}</span>
              {st.meta && <span className={`shrink-0 text-[11px] ${st.state === 'need' ? 'text-warn' : st.state === 'error' ? 'text-bad' : 'text-ink-3'}`}>{st.meta}</span>}
            </div>
          ))}
          <div className="font-sans flex items-center gap-1.5 pl-[34px] pr-3 pt-0.5 pb-2 text-[11px] text-ink-3">
            {formatTokens(tokenCount(info?.usage))} tokens · {subagentFiles(events)}
            {sub.startedAt && sub.endedAt ? ` · ${formatDuration(sub.endedAt - sub.startedAt)}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY: AgentEvent[] = [];

function Notice({ tone, children }: { tone: 'info' | 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const color = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-ink-3';
  return (
    <div className={`flex items-center gap-2.5 text-[11.5px] ${color}`}>
      <span aria-hidden="true" className="flex-1 h-px bg-line" />
      <span>{children}</span>
      <span aria-hidden="true" className="flex-1 h-px bg-line" />
    </div>
  );
}

function ResultLine({ row }: { row: Extract<TranscriptRow, { kind: 'result' }> }) {
  if (row.localCommand) return <Notice tone="info">/{row.localCommand} finished</Notice>;
  const parts = [row.numTurns ? `${row.numTurns} ${row.numTurns === 1 ? 'turn' : 'turns'}` : '', row.durationMs ? formatSeconds(row.durationMs) : ''].filter(Boolean);
  if (row.isError) {
    return <Notice tone="bad">{row.subtype === 'error_during_execution' ? 'Turn stopped' : `Turn ended with an error (${row.subtype})`}{parts.length ? ` · ${parts.join(' · ')}` : ''}</Notice>;
  }
  return <Notice tone="info">Turn finished{parts.length ? ` · ${parts.join(' · ')}` : ''}</Notice>;
}

function formatSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function Callout({ tone, icon, title, children }: { tone: 'bad' | 'warn'; icon: 'alert-circle' | 'warning'; title: string; children: ReactNode }) {
  return (
    <div role={tone === 'bad' ? 'alert' : undefined} className={`flex gap-2.5 items-start px-3 py-2.5 rounded-[10px] border text-[12.5px] leading-[1.5] ${tone === 'bad' ? 'bg-bad-bg border-bad-line' : 'bg-warn-bg border-warn-line'}`}>
      <Icon name={icon} size={16} className={`mt-px ${tone === 'bad' ? 'text-bad' : 'text-warn'}`} />
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className={`font-semibold ${tone === 'bad' ? 'text-bad-bright' : 'text-warn'}`}>{title}</span>
        <span className="text-ink-2 break-words">{children}</span>
      </div>
    </div>
  );
}

function ReviewCard({ summary, checks, onOpen }: { summary: string; checks: Array<{ name: string; status: string; detail?: string }>; onOpen: () => void }) {
  return (
    <div className="flex flex-col gap-2 px-3.5 py-3 rounded-[10px] border border-review-line bg-review-bg">
      <div className="flex items-center gap-2">
        <Icon name="check" size={16} className="text-review" />
        <span className="flex-1 font-semibold text-[12.5px] text-review">Submitted for review</span>
        <Button size={28} variant="review-outline" onClick={onOpen}>
          Review changes
        </Button>
      </div>
      <Markdown text={summary} className="text-[12.5px]" />
      {checks.length > 0 && (
        <ul className="m-0 p-0 list-none flex flex-col gap-1 text-[12px]">
          {checks.map((c, i) => (
            <li key={i} className="flex gap-2 items-center">
              <span aria-hidden="true" className={c.status === 'passed' ? 'text-ok' : c.status === 'failed' ? 'text-bad' : 'text-warn'}>
                ●
              </span>
              <span className="text-ink-2">{c.name}</span>
              {c.detail && <span className="text-ink-3">· {c.detail}</span>}
              <span className="sr-only">({c.status})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
