import {
  CliEventType,
  countBucket,
  durationBucket,
  modelFamilyOf,
  settingKeysOf,
  slashCommandOf,
  tokenBucket,
  toolCategoryOf,
  MarketplaceExtensionId,
  type AgentEvent,
  type ArchiveReason,
  type AgentSpec,
  type CommandName,
  type EventName,
  type InstalledExtension,
  type MessageAttachment,
  type PermissionAnswer,
  type SearchResultsEvent,
  type TelemetryEventName,
  type TelemetryEventProps,
  type ToolCategory,
  type UserMessage,
} from '@oide/protocol';
import type { ErrorSource } from './service.js';

/**
 * Turns what main already sees into catalogue events, so screens need no instrumentation:
 * - `command(name, input, output)`: every successful IPC command (IpcRouter `observe`);
 * - `agentEvent(e)`: every normalized agent event (the `agentEvents` batcher);
 * - `emitted(event, payload)`: every main → renderer event.
 * Only enum-like facts leave this file (model family, mode, counts, buckets); never titles, goals,
 * paths, tool inputs or text.
 */

export interface TelemetrySink {
  track<K extends TelemetryEventName>(name: K, props: TelemetryEventProps<K>): boolean;
  error(
    e: unknown,
    opts: { source: ErrorSource; process: string; handled?: boolean; tags?: Record<string, string> },
  ): boolean;
}

export interface ObserverOptions {
  /** True when the marketplace index in use is the official one (Settings › Extensions › index URL empty). */
  officialIndex: () => boolean;
  now?: () => number;
  /** Quiet time that closes a run of searches into one `file_search_used` (default 4 s). */
  searchIdleMs?: number;
  /** Minimum gap between two `setting_changed` for the same key (default 10 s). */
  settingGapMs?: number;
}

interface Run {
  startedAt: number;
  firstOutputAt?: number;
  tokens: number;
  subagents: Set<string>;
  turns?: number;
  errorCode?: string;
}

const TERMINAL = new Set(['ready-for-review', 'done', 'error', 'stopped']);
const OUTPUT_EVENTS = new Set(['partial', 'assistant-text', 'thinking', 'tool-use']);
const ERROR_CODES = new Set(['auth', 'model_not_found', 'api_error', 'spawn', 'protocol']);

function attachmentCounts(list: readonly MessageAttachment[] | undefined): { images: number; files: number } {
  let images = 0;
  let files = 0;
  for (const a of list ?? []) {
    if (a.kind === 'image') images++;
    else files++;
  }
  return { images: Math.min(images, 50), files: Math.min(files, 50) };
}

interface SearchAgg {
  queries: number;
  results: number;
  regex?: boolean;
  engine?: 'git-grep' | 'scan' | 'mixed';
  timer: ReturnType<typeof setTimeout> | null;
}

export class TelemetryObservers {
  private readonly runs = new Map<string, Run>();
  private readonly pending = new Map<string, { tool: ToolCategory; at: number }>();
  private readonly unknownCounts = new Map<string, number>();
  private readonly contentSearches = new Map<string, boolean>();
  private readonly search: Record<'name' | 'content', SearchAgg> = {
    name: { queries: 0, results: 0, timer: null },
    content: { queries: 0, results: 0, timer: null },
  };
  private readonly lastSetting = new Map<string, number>();
  private readonly errorCodeSeen = new Map<string, number>();
  private readonly prUrls = new Set<string>();
  private readonly prState = new Map<string, string>();
  private readonly archived = new Map<string, ArchiveReason>();
  /** Merge predictions already reported (agent + both commits), so re-opening the dialog counts once. */
  private readonly predicted = new Set<string>();
  /** Agents resolving merge conflicts oIDE sent them, and since when. */
  private readonly resolving = new Map<string, number>();

  constructor(
    private readonly sink: TelemetrySink,
    private readonly o: ObserverOptions,
  ) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  // ---------------------------------------------------------------------------- commands

  command(name: CommandName, input: unknown, output: unknown): void {
    switch (name) {
      case 'agents.spawn': {
        const spec = input as AgentSpec;
        const a = attachmentCounts(spec.attachments);
        this.sink.track('agent_spawned', {
          model: modelFamilyOf(spec.strategy.lead.model, !!spec.customModel),
          effort: spec.strategy.lead.effort ?? 'default',
          strategy: spec.strategy.kind,
          mode: spec.mode,
          work_in: spec.workIn,
          attempts: spec.attempts,
          has_attachments: a.images + a.files > 0,
          has_context: spec.context.length > 0,
          techniques: Math.min(spec.techniques.length, 10_000),
          extensions: Math.min(spec.extensions.length, 10_000),
        });
        if (a.images + a.files > 0) this.sink.track('attachments_sent', { where: 'spawn', ...a });
        return;
      }
      case 'agents.send': {
        const { message } = input as { message: UserMessage };
        if (message.kind === 'command')
          this.sink.track('slash_command_used', { command: slashCommandOf(message.command) });
        else if (message.kind === 'text' || message.kind === 'artifact') {
          const a = attachmentCounts(message.attachments);
          if (a.images + a.files > 0) this.sink.track('attachments_sent', { where: 'message', ...a });
        }
        return;
      }
      case 'agents.answerPermission': {
        const { answer } = input as { answer: PermissionAnswer };
        const p = this.pending.get(answer.requestId);
        this.pending.delete(answer.requestId);
        const decision = answer.behavior === 'deny' ? 'deny' : answer.always ? 'always' : 'allow';
        this.sink.track('permission_answered', {
          decision,
          tool: p?.tool ?? 'other',
          wait: durationBucket(p ? this.now - p.at : 0),
        });
        return;
      }
      case 'agents.compact':
        this.sink.track('compact_requested', {});
        return;
      case 'agents.remove':
        this.sink.track('agent_discarded', {
          worktree_deleted: !!(input as { deleteWorktree?: boolean }).deleteWorktree,
        });
        return;
      case 'git.mergeLocal':
        this.sink.track('agent_merged', { result: (output as { ok?: boolean }).ok ? 'merged' : 'conflicts' });
        return;
      case 'git.predictMerge': {
        const o = output as { agentId: string; status: string; files?: string[]; binary?: string[]; submodules?: string[]; target?: { sha: string }; branchSha?: string };
        if (o.status !== 'conflicts') return;
        const key = [o.agentId, o.target?.sha ?? '', o.branchSha ?? ''].join(':');
        if (this.predicted.has(key)) return;
        this.predicted.add(key);
        if (this.predicted.size > 500) this.predicted.delete(this.predicted.values().next().value!);
        this.sink.track('merge_conflict_predicted', {
          files: countBucket(o.files?.length ?? 0),
          binary: (o.binary?.length ?? 0) > 0,
          submodules: (o.submodules?.length ?? 0) > 0,
        });
        return;
      }
      case 'git.askToResolve': {
        const i = input as { agentId: string; source?: 'prediction' | 'merge' };
        const o = output as { files: number; unarchived: boolean; resumed: boolean };
        this.resolving.set(i.agentId, this.now);
        if (this.resolving.size > 500) this.resolving.delete(this.resolving.keys().next().value!);
        this.sink.track('merge_conflict_sent_to_agent', {
          source: i.source ?? 'prediction',
          files: countBucket(o.files),
          agent: o.unarchived ? 'unarchived' : o.resumed ? 'resumed' : 'running',
        });
        return;
      }
      case 'git.openPr':
        this.sink.track('pr_opened', { existing: !!(output as { existing?: boolean }).existing });
        return;
      case 'agents.archive':
        // Reported from the `agents.archived` event (covers automatic archiving too).
        return;
      case 'agents.unarchive':
        this.archived.delete((input as { agentId: string }).agentId);
        this.sink.track('agent_unarchived', {});
        return;
      case 'agents.deletePermanently':
        if ((output as { deleted?: boolean }).deleted) this.sink.track('agent_deleted', {});
        return;
      case 'shell.openExternal': {
        // View PR: the URL itself is never sent; it only has to be the PR of an agent main knows.
        if (this.prUrls.has((input as { url: string }).url)) this.sink.track('pr_view_opened', {});
        return;
      }
      case 'files.findByName':
        this.noteSearch('name', (output as { results?: unknown[] }).results?.length ?? 0);
        return;
      case 'files.searchContent': {
        const i = input as { searchId: string; isRegex?: boolean };
        this.contentSearches.set(i.searchId, !!i.isRegex);
        if (this.contentSearches.size > 100)
          this.contentSearches.delete(this.contentSearches.keys().next().value!);
        return;
      }
      case 'files.replace': {
        const results = (output as { results?: Array<{ status: string }> }).results ?? [];
        this.sink.track('file_search_used', {
          kind: 'replace',
          results: countBucket(results.filter((r) => r.status === 'replaced').length),
          queries: 1,
          regex: !!(input as { isRegex?: boolean }).isRegex,
        });
        return;
      }
      case 'artifacts.import': {
        // Never the link, title or content: how it came in, the kind and the format only.
        const i = input as { url?: string; content?: string; filePath?: string };
        const out = output as { kind?: unknown; entry?: unknown };
        const kind = out.kind;
        if (kind !== 'design' && kind !== 'doc' && kind !== 'whiteboard') return;
        if (!i.filePath && !i.content?.trim()) return; // refused by main; never created
        const source = i.filePath ? 'file' : 'link_content';
        const svg = i.filePath
          ? /\.svg$/i.test(i.filePath)
          : /^\s*(?:<\?xml[^>]{0,200}>\s*)?(?:<!doctype\s+svg[^>]{0,400}>\s*)?<svg[\s>]/i.test(i.content?.slice(0, 4096) ?? '');
        const format = kind === 'doc' ? 'markdown' : kind === 'whiteboard' ? 'excalidraw' : out.entry === 'App.jsx' ? 'react' : svg ? 'svg' : 'html';
        this.sink.track('artifact_imported', { source, kind, linked: !!i.url, format });
        return;
      }
      case 'extensions.install': {
        const ext = output as InstalledExtension;
        if (
          (ext.source === 'marketplace' || ext.source === 'builtin') &&
          this.o.officialIndex() &&
          MarketplaceExtensionId.safeParse(ext.name).success
        ) {
          this.sink.track('extension_installed', { extension: ext.name, source: ext.source });
        }
        return;
      }
      case 'settings.update': {
        for (const key of settingKeysOf((input as { patch?: unknown }).patch)) {
          const last = this.lastSetting.get(key) ?? -Infinity;
          if (this.now - last < (this.o.settingGapMs ?? 10_000)) continue;
          this.lastSetting.set(key, this.now);
          this.sink.track('setting_changed', { key });
        }
        return;
      }
      default:
        return;
    }
  }

  private noteSearch(
    kind: 'name' | 'content',
    results: number,
    extra: { regex?: boolean; engine?: SearchAgg['engine'] } = {},
  ): void {
    const s = this.search[kind];
    s.queries++;
    s.results = results;
    if (extra.regex !== undefined) s.regex = extra.regex;
    if (extra.engine) s.engine = extra.engine;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => this.closeSearch(kind), this.o.searchIdleMs ?? 4_000);
    (s.timer as { unref?: () => void }).unref?.();
  }

  /** One `file_search_used` per run of queries (typing in quick open fires one query per keystroke). */
  /**
   * A command main refused (IpcRouter `observeFailure`): codes, reasons and issue paths only, never the
   * input. Used for claude.ai imports refused before anything was created.
   */
  commandFailed(name: CommandName, failure: { code: string; reason?: string; issues?: Array<{ path: string; code: string }> }): void {
    if (name !== 'artifacts.import') return;
    const reasons = ['no_content', 'bad_link', 'wrong_kind', 'too_large', 'stub_content'] as const;
    type Reason = (typeof reasons)[number] | 'other';
    let reason: Reason = 'other';
    if (failure.reason && (reasons as readonly string[]).includes(failure.reason)) reason = failure.reason as Reason;
    else if (failure.issues?.length) {
      const first = failure.issues[0]!;
      if (first.path === 'url') reason = 'bad_link';
      else if (first.path === 'content' && first.code === 'too_big') reason = 'too_large';
      else if (first.path === '' && first.code === 'custom') reason = 'no_content';
    }
    this.sink.track('artifact_import_refused', { reason });
  }

  closeSearch(kind: 'name' | 'content'): void {
    const s = this.search[kind];
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (!s.queries) return;
    this.sink.track('file_search_used', {
      kind,
      results: countBucket(s.results),
      queries: Math.min(s.queries, 10_000),
      ...(s.regex !== undefined ? { regex: s.regex } : {}),
      ...(s.engine ? { engine: s.engine } : {}),
    });
    this.search[kind] = { queries: 0, results: 0, timer: null };
  }

  // ------------------------------------------------------------------------- agent events

  agentEvent(e: AgentEvent): void {
    const run = this.runs.get(e.agentId);
    if (OUTPUT_EVENTS.has(e.type)) {
      if (run && run.firstOutputAt === undefined) run.firstOutputAt = e.ts;
      return;
    }
    switch (e.type) {
      case 'status': {
        if (e.status === 'starting' || (e.status === 'running' && !run)) {
          if (!run) this.runs.set(e.agentId, { startedAt: e.ts, tokens: 0, subagents: new Set() });
        } else if (TERMINAL.has(e.status) && run) {
          this.runs.delete(e.agentId);
          const duration = Math.max(0, e.ts - run.startedAt);
          this.sink.track('agent_finished', {
            outcome: e.status as 'ready-for-review' | 'done' | 'error' | 'stopped',
            duration: durationBucket(duration),
            duration_ms: Math.min(duration, 86_400_000),
            ...(run.firstOutputAt !== undefined
              ? { first_output_ms: Math.min(Math.max(0, run.firstOutputAt - run.startedAt), 86_400_000) }
              : {}),
            subagents: countBucket(run.subagents.size),
            tokens: tokenBucket(run.tokens),
            ...(run.turns !== undefined ? { turns: countBucket(run.turns) } : {}),
            ...(run.errorCode ? { error_code: run.errorCode as 'auth' } : {}),
          });
        }
        return;
      }
      case 'usage':
        if (run) run.tokens += e.usage.input + e.usage.output;
        return;
      case 'subagent':
        run?.subagents.add(e.subagent.id);
        return;
      case 'result':
        if (run && e.numTurns !== undefined) run.turns = e.numTurns;
        return;
      case 'review-submitted': {
        const since = this.resolving.get(e.agentId);
        if (since === undefined || e.parentToolUseId) return;
        this.resolving.delete(e.agentId);
        this.sink.track('merge_conflict_resolved', { duration: durationBucket(Math.max(0, e.ts - since)) });
        return;
      }
      case 'permission-request':
        this.pending.set(e.request.requestId, {
          tool: toolCategoryOf(e.request.toolName),
          at: e.request.createdAt || e.ts,
        });
        if (this.pending.size > 500) this.pending.delete(this.pending.keys().next().value!);
        return;
      case 'permission-resolved':
        // Answered for the user (oIDE quitting): not a decision, so it is never reported.
        if (e.reason === 'quit') this.pending.delete(e.requestId);
        return;
      case 'error': {
        const code = e.code && ERROR_CODES.has(e.code) ? e.code : 'other';
        if (run) run.errorCode = code;
        // Agent driver failures as error reports: the code only, never the CLI's message.
        const last = this.errorCodeSeen.get(code) ?? -Infinity;
        if (this.now - last >= 10 * 60_000) {
          this.errorCodeSeen.set(code, this.now);
          this.sink.error(
            { name: 'AgentError', message: `agent error: ${code}`, stack: '' },
            { source: 'agent', process: 'agent', handled: true, tags: { code } },
          );
        }
        return;
      }
      case 'unknown': {
        const t = CliEventType.safeParse(e.rawType.toLowerCase());
        const key = t.success ? t.data : 'unparsed';
        if (this.unknownCounts.size < 50 || this.unknownCounts.has(key))
          this.unknownCounts.set(key, (this.unknownCounts.get(key) ?? 0) + 1);
        return;
      }
      default:
        return;
    }
  }

  /** Report the CLI event types oIDE did not recognise since the last call (top 5), then reset. */
  flushUnknownCliEvents(): void {
    const top = [...this.unknownCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    this.unknownCounts.clear();
    for (const [event_type, count] of top)
      if (event_type !== 'unparsed')
        this.sink.track('cli_unknown_event', { event_type, count: Math.min(count, 1_000_000) });
  }

  // ------------------------------------------------------------------------- emitted events

  /** PR state per agent and archive reason per agent (memory only), so each change is reported once. */
  private notePr(summary: { id?: string; pr?: { url: string; state: string } }): void {
    if (!summary.id || !summary.pr) return;
    this.prUrls.add(summary.pr.url);
    if (this.prUrls.size > 1000) this.prUrls.delete(this.prUrls.values().next().value!);
    const prev = this.prState.get(summary.id);
    this.prState.set(summary.id, summary.pr.state);
    if (summary.pr.state === 'merged' && prev !== undefined && prev !== 'merged')
      this.sink.track('pr_merged_detected', {});
  }

  emitted(event: EventName, payload: unknown): void {
    if (event === 'agents.summary' || event === 'agents.archived') {
      const s = payload as {
        id?: string;
        pr?: { url: string; state: string };
        archived?: { reason: ArchiveReason };
      };
      this.notePr(s);
      if (
        event === 'agents.archived' &&
        s.id &&
        s.archived &&
        this.archived.get(s.id) !== s.archived.reason
      ) {
        this.archived.set(s.id, s.archived.reason);
        if (this.archived.size > 5000) this.archived.delete(this.archived.keys().next().value!);
        this.sink.track('agent_archived', { reason: s.archived.reason });
      }
      return;
    }
    if (event === 'files.searchResults') {
      const r = payload as SearchResultsEvent;
      if (!r.done || !this.contentSearches.has(r.searchId)) return;
      const regex = this.contentSearches.get(r.searchId);
      this.contentSearches.delete(r.searchId);
      if (r.cancelled) return;
      const matches = r.stats?.matches ?? r.files.reduce((n, f) => n + f.matches.length, 0);
      this.noteSearch('content', matches, {
        ...(regex !== undefined ? { regex } : {}),
        ...(r.stats?.engine ? { engine: r.stats.engine } : {}),
      });
    } else if (event === 'agents.removed') {
      const id = (payload as { agentId?: string }).agentId;
      if (id) this.runs.delete(id);
    } else if (event === 'extensions.hostState') {
      // The extension's name is never sent (it may be a local or custom one).
      if ((payload as { state?: string }).state === 'failed')
        this.sink.error(
          { name: 'ExtensionHostFailed', message: 'extension host failed', stack: '' },
          { source: 'extension-host', process: 'extension-host', handled: true },
        );
    }
  }

  dispose(): void {
    for (const k of ['name', 'content'] as const)
      if (this.search[k].timer) clearTimeout(this.search[k].timer!);
  }
}
