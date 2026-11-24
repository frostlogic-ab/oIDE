import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ArtifactMeta } from '@oide/protocol';
import { Chip, Icon } from '@oide/ui';
import { invokeOr, ipcErrorMessage, oide } from '../../../lib/bridge';
import { toast } from '../../../stores/ui';
import { composeMessage, filterSlash, slashHelp } from '../model/focus';

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
}

/**
 * "Steer this agent, or type / for commands". Enter or Ctrl/Cmd+Enter sends, Shift+Enter adds a
 * line. A leading "/" opens the CLI's command list; /compact asks first (confirm dialog).
 * Attach artifact picks from `artifacts.list` and sends an artifact UserMessage.
 */
export function Composer({ agentId, projectId, placeholder, commands, subagentName, disabledReason, onCompact, onCycleMode }: ComposerProps) {
  const [text, setText] = useState('');
  const [artifact, setArtifact] = useState<ArtifactMeta | null>(null);
  const [sending, setSending] = useState(false);
  const [active, setActive] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const pickerId = useId();
  const disabled = !!disabledReason;

  const slashQuery = /^\/[\w:-]*$/.test(text) ? text : null;
  const matches = useMemo(() => (slashQuery !== null ? filterSlash(commands, slashQuery) : []), [commands, slashQuery]);
  const menuOpen = slashQuery !== null && !menuDismissed && matches.length > 0;

  useEffect(() => setActive(0), [slashQuery]);
  useEffect(() => {
    setText('');
    setArtifact(null);
  }, [agentId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [text]);

  const pick = (cmd: string) => {
    setText(`/${cmd}`);
    setMenuDismissed(true);
    ref.current?.focus();
  };

  const send = async () => {
    if (sending || disabled) return;
    const intent = composeMessage({ text, artifactId: artifact?.id, subagentName, commands });
    if (intent.kind === 'none') return;
    if (intent.kind === 'compact') {
      setText('');
      onCompact();
      return;
    }
    setSending(true);
    try {
      await oide.invoke('agents.send', { agentId, message: intent.message });
      setText('');
      setArtifact(null);
      setMenuDismissed(false);
    } catch (err) {
      toast(ipcErrorMessage(err), 'error');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) || e.key === 'Tab') {
        const cmd = matches[active];
        if (cmd && `/${cmd}` !== text) {
          e.preventDefault();
          pick(cmd);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMenuDismissed(true);
        return;
      }
    }
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

  const canSend = !disabled && !sending && (text.trim() !== '' || artifact !== null);

  return (
    <div className="relative">
      {menuOpen && (
        <div id={listId} role="listbox" aria-label="Commands" className="absolute bottom-[calc(100%+6px)] left-0 right-0 z-30 py-1 rounded-[10px] border border-line-3 bg-card shadow-dialog">
          {matches.map((c, i) => (
            <div
              key={c}
              id={`${listId}-${c}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex items-center gap-3 h-8 px-3 cursor-pointer text-[12.5px] ${i === active ? 'bg-selected' : ''}`}
            >
              <span className="font-mono text-ink w-[96px]">/{c}</span>
              <span className="text-ink-3 truncate">{slashHelp(c)}</span>
            </div>
          ))}
        </div>
      )}
      {pickerOpen && (
        <ArtifactPicker
          id={pickerId}
          projectId={projectId}
          onPick={(a) => {
            setArtifact(a);
            setPickerOpen(false);
            ref.current?.focus();
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div className={`flex items-center gap-2 py-2 pr-2 pl-3.5 border border-line-3 bg-card rounded-xl ${disabled ? 'opacity-60' : ''}`}>
        {artifact && (
          <Chip icon="artifacts" onRemove={() => setArtifact(null)} removeLabel={`Remove ${artifact.title}`} className="shrink-0">
            {artifact.title}
          </Chip>
        )}
        <label htmlFor={`${listId}-input`} className="sr-only">
          {subagentName ? `Message the lead agent about ${subagentName}` : 'Message this agent'}
        </label>
        <textarea
          ref={ref}
          id={`${listId}-input`}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabledReason ?? placeholder}
          role="combobox"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={menuOpen && matches[active] ? `${listId}-${matches[active]}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setMenuDismissed(false);
          }}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 resize-none border-0 outline-none bg-transparent text-ink text-[13.5px] leading-[20px] py-[5px] placeholder:text-ink-3 focus-visible:outline-none"
        />
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          disabled={disabled}
          onClick={() => setPickerOpen((o) => !o)}
          className="h-[30px] px-2.5 shrink-0 rounded-[7px] border border-line-3 bg-transparent text-ink-2 text-[12px] flex items-center gap-[5px] hover:bg-raised disabled:opacity-50"
        >
          <Icon name="artifacts" size={14} />
          Attach artifact
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
  );
}

function ArtifactPicker({ id, projectId, onPick, onClose }: { id: string; projectId: string; onPick(a: ArtifactMeta): void; onClose(): void }) {
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

  useEffect(() => {
    if (list?.length) first.current?.focus();
  }, [list]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div
      ref={wrap}
      id={id}
      role="dialog"
      aria-label="Attach an artifact"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      className="absolute bottom-[calc(100%+6px)] right-10 z-30 w-[300px] max-h-[280px] overflow-auto py-1 rounded-[10px] border border-line-3 bg-card shadow-dialog"
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
