import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { ArtifactMeta, UserMessage } from '@oide/protocol';
import { Chip, Icon } from '@oide/ui';
import { AttachFileButton, AttachmentTray, useAttachments } from '../../../components/Attachments';
import { SlashMenu, useSlashMenu } from '../../../components/SlashMenu';
import { invokeOr, ipcErrorMessage, oide } from '../../../lib/bridge';
import { insertText } from '../../../lib/slash';
import { toast } from '../../../stores/ui';
import { composeMessage } from '../model/focus';
import { getDraft, onDraftChange, setDraft } from '../composerDrafts';

export interface ComposerProps {
  agentId: string;
  projectId: string;
  placeholder: string;
  /** Slash commands the CLI supports (without "/"). */
  commands: readonly string[];
  /** When viewing a subagent: messages still go to the lead, about this subagent. */
  subagentName?: string;
  /** Queued agents cannot take messages yet. */
  disabledReason?: string;
  onCompact(): void;
  /** Shift+Tab in the composer switches the permission mode, as in the CLI. */
  onCycleMode?(): void;
  /** Called after a message went out (the Artifacts agent panel counts them for telemetry). */
  onSent?(message: UserMessage): void;
  /** A narrow host (the Artifacts agent panel): Attach artifact shows its icon only. */
  compact?: boolean;
}

/**
 * "Steer this agent, or type / for commands". Enter or Ctrl/Cmd+Enter sends, Shift+Enter adds a
 * line. A leading "/" opens the CLI's command list (SlashMenu); picking inserts `/<command> ` and
 * `/compact` asks first (confirm dialog). Screenshots paste in as images, files drop in or come from
 * Attach file; they show as chips and go with the next message. Attach artifact picks from
 * `artifacts.list` and sends an artifact UserMessage.
 */
/** What is left of the composer text once `sent` went out: text typed after it, else what is there. */
export function afterSent(current: string, sent: string): string {
  if (current === sent) return '';
  if (sent !== '' && current.startsWith(sent)) return current.slice(sent.length).replace(/^\s+/, '');
  return current;
}

export function Composer({ agentId, projectId, placeholder, commands, subagentName, disabledReason, onCompact, onCycleMode, onSent, compact }: ComposerProps) {
  // The text belongs to one agent. Switching agents swaps in that agent's saved draft during render
  // (no flash of the previous agent's text); every edit is mirrored into the draft store.
  const [draft, setDraftState] = useState(() => ({ agentId, text: getDraft(agentId) }));
  const text = draft.agentId === agentId ? draft.text : getDraft(agentId);
  if (draft.agentId !== agentId) setDraftState({ agentId, text });
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  const setText = (next: string) => {
    setDraft(agentId, next);
    setDraftState({ agentId, text: next });
  };
  const [artifact, setArtifact] = useState<ArtifactMeta | null>(null);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  const pickerId = useId();
  const disabled = !!disabledReason;
  const atts = useAttachments({ disabled });
  const { clear: clearAttachments } = atts;

  const menu = useSlashMenu({
    text,
    commands,
    onPick: (item) => {
      if (item.name === 'compact') {
        setText('');
        onCompact();
        return;
      }
      setText(insertText(item));
      ref.current?.focus();
    },
  });

  // A send started by an earlier mount of this composer finished: show what it left.
  useEffect(
    () =>
      onDraftChange((id, next) => {
        if (id === agentRef.current) setDraftState({ agentId: id, text: next });
      }),
    [],
  );

  // The text comes back per agent (above); the picked artifact and attachments are not kept.
  useEffect(() => {
    setArtifact(null);
    clearAttachments();
  }, [agentId, clearAttachments]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  /** Esc or a pick hands focus back to the trigger; an outside click leaves it where the user clicked. */
  const closePicker = useCallback((restoreFocus: boolean) => {
    setPickerOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const send = async () => {
    if (sending || disabled || atts.busy) return;
    const intent = composeMessage({ text, artifactId: artifact?.id, subagentName, commands, attachments: atts.attachments });
    if (intent.kind === 'none') return;
    if (intent.kind === 'compact') {
      setText('');
      onCompact();
      return;
    }
    setSending(true);
    try {
      await oide.invoke('agents.send', { agentId, message: intent.message });
      onSent?.(intent.message);
      // The sent text goes; anything typed after it while the send was in flight stays (without the
      // sent part, so Enter does not send it again). If the user has switched agents meanwhile, the
      // visible composer belongs to someone else: only that agent's stored draft changes.
      const rest = afterSent(getDraft(agentId), text);
      // Notify: a Composer mounted again for this agent while the send was in flight shows the rest too.
      setDraft(agentId, rest, true);
      if (agentRef.current === agentId) {
        setDraftState({ agentId, text: rest });
        setArtifact(null);
        atts.clear();
      }
    } catch (err) {
      toast(ipcErrorMessage(err), 'error');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu.onKeyDown(e)) return;
    if (e.key === 'Tab' && e.shiftKey && onCycleMode) {
      e.preventDefault();
      onCycleMode();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const canSend = !disabled && !sending && !atts.busy && (text.trim() !== '' || artifact !== null || atts.items.length > 0);

  return (
    <div className="relative" {...atts.dropProps}>
      <SlashMenu menu={menu} />
      {pickerOpen && (
        <ArtifactPicker
          id={pickerId}
          projectId={projectId}
          triggerRef={triggerRef}
          onPick={(a) => {
            setArtifact(a);
            setPickerOpen(false);
            ref.current?.focus();
          }}
          onClose={closePicker}
        />
      )}
      <div
        className={`flex flex-col gap-2 py-2 pr-2 pl-3.5 border bg-card rounded-xl ${atts.dragging ? 'border-accent' : 'border-line-3'} ${disabled ? 'opacity-60' : ''}`}
      >
        <AttachmentTray state={atts} className="pr-1.5" />
        <div className="flex items-center gap-2">
          {artifact && (
            <Chip icon="artifacts" onRemove={() => setArtifact(null)} removeLabel={`Remove ${artifact.title}`} className="shrink-0">
              {artifact.title}
            </Chip>
          )}
          <label htmlFor={inputId} className="sr-only">
            {subagentName ? `Message the lead agent about ${subagentName}` : 'Message this agent'}
          </label>
          <textarea
            ref={ref}
            id={inputId}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={atts.dragging ? 'Drop to attach' : (disabledReason ?? placeholder)}
            {...menu.inputProps}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={atts.onPaste}
            className="flex-1 min-w-0 resize-none border-0 outline-none bg-transparent text-ink text-[13.5px] leading-[20px] py-[5px] placeholder:text-ink-3 focus-visible:outline-none"
          />
          <AttachFileButton state={atts} disabled={disabled} />
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            aria-controls={pickerOpen ? pickerId : undefined}
            disabled={disabled}
            onClick={() => setPickerOpen((o) => !o)}
            aria-label={compact ? 'Attach artifact' : undefined}
            title={compact ? 'Attach artifact' : undefined}
            className={`h-[30px] shrink-0 rounded-[7px] border border-line-3 bg-transparent text-ink-2 text-[12px] flex items-center gap-[5px] hover:bg-raised disabled:opacity-50 ${compact ? 'w-[30px] justify-center' : 'px-2.5'}`}
          >
            <Icon name="artifacts" size={14} />
            {!compact && 'Attach artifact'}
          </button>
          <button
            type="button"
            aria-label={sending ? 'Sending' : 'Send'}
            title="Send (Enter or Ctrl+Enter)"
            disabled={!canSend}
            onClick={() => void send()}
            className="w-8 h-8 shrink-0 rounded-md border-0 bg-accent text-on-accent flex items-center justify-center hover:brightness-110 disabled:opacity-50"
          >
            <Icon name="arrow-up" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ArtifactPicker({
  id,
  projectId,
  triggerRef,
  onPick,
  onClose,
}: {
  id: string;
  projectId: string;
  /** The button that opens the picker: clicking it is the trigger's own toggle, not an outside click. */
  triggerRef: RefObject<HTMLElement | null>;
  onPick(a: ArtifactMeta): void;
  onClose(restoreFocus: boolean): void;
}) {
  const [list, setList] = useState<ArtifactMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    invokeOr('artifacts.list', { projectId }, [] as ArtifactMeta[]).then(
      (l) => !cancelled && setList(l),
      (err: unknown) => !cancelled && setError(ipcErrorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Focus always moves into the picker (first item when there is one, else the dialog itself) so Esc
  // is handled here and does not fall through to the global view.back.
  useEffect(() => {
    if (list?.length) first.current?.focus();
    else wrap.current?.focus();
  }, [list, error]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrap.current?.contains(t) || triggerRef.current?.contains(t)) return;
      onClose(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose, triggerRef]);

  return (
    <div
      ref={wrap}
      id={id}
      role="dialog"
      aria-label="Attach an artifact"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
        }
      }}
      className="absolute bottom-[calc(100%+6px)] right-10 z-30 w-[300px] max-h-[280px] overflow-auto py-1 rounded-[10px] border border-line-3 bg-card shadow-dialog focus:outline-none"
    >
      <div className="px-3 pt-1.5 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Artifacts</div>
      {error && <div className="px-3 py-2 text-[12px] text-bad">{error}</div>}
      {!list && !error && <div className="px-3 py-2 text-[12px] text-ink-3">Loading…</div>}
      {list?.length === 0 && <div className="px-3 py-2 text-[12px] text-ink-3">No artifacts in this project yet.</div>}
      {list?.map((a, i) => (
        <button
          key={a.id}
          ref={i === 0 ? first : undefined}
          type="button"
          onClick={() => onPick(a)}
          className="w-full flex items-center gap-2 h-9 px-3 border-0 bg-transparent text-left text-[12.5px] text-ink hover:bg-selected focus-visible:bg-selected"
        >
          <Icon name="artifacts" size={14} className="text-ink-3" />
          <span className="flex-1 truncate">{a.title}</span>
          <span className="text-[11px] text-ink-3 capitalize">{a.kind}</span>
        </button>
      ))}
    </div>
  );
}
