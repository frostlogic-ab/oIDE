/**
 * Small Marketplace building blocks: the design's checkbox-like toggle, editable tool rows,
 * the monogram tile, the "Save it in" / "Turn on for" fields and an accessible modal shell for
 * the Add custom dialog (its header, tabs and footer differ from the kit's Dialog).
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { Project, ToolRisk } from '@oide/protocol';
import { Icon, cn } from '@oide/ui';
import { useKeymapScope } from '../../lib/useKeymap';
import { RISK_COLOR, RISK_LABEL, monogram, tintFor } from './model';

export interface EditableTool {
  name: string;
  description?: string;
  risk: ToolRisk;
  enabled: boolean;
}

/** 18px square checkbox drawn as in the design (role=checkbox on a real button). */
export function CheckButton({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'w-[18px] h-[18px] shrink-0 p-0 rounded-[5px] border-[1.5px] flex items-center justify-center text-on-accent disabled:opacity-40',
        checked ? 'border-accent bg-accent' : 'border-line-hover bg-transparent',
      )}
    >
      {checked && <Icon name="check" size={12} style={{ strokeWidth: 3 }} />}
    </button>
  );
}

export function RiskPill({ risk, onToggle, toolName }: { risk: ToolRisk; onToggle?: () => void; toolName: string }) {
  const style = { borderColor: RISK_COLOR[risk], color: RISK_COLOR[risk] };
  const cls = 'h-[22px] px-2 rounded-[11px] border bg-transparent text-[11px] whitespace-nowrap inline-flex items-center';
  if (!onToggle) return <span className={cls} style={style}>{RISK_LABEL[risk]}</span>;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(cls, 'hover:brightness-125')}
      style={style}
      aria-label={`${toolName}: ${RISK_LABEL[risk]}. Change to ${RISK_LABEL[risk === 'read' ? 'ask' : 'read']}`}
    >
      {RISK_LABEL[risk]}
    </button>
  );
}

/** "Tools agents can use": on/off toggle, mono name, description, risk pill (editable unless `readOnlyRisk`). */
export function ToolRows({ tools, onChange, readOnlyRisk, heading = 'Tools agents can use', hint }: {
  tools: EditableTool[];
  onChange?: (tools: EditableTool[]) => void;
  readOnlyRisk?: boolean;
  heading?: string;
  hint?: string;
}) {
  const set = (i: number, patch: Partial<EditableTool>) => onChange?.(tools.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">{heading}</span>
        <span className="text-[11.5px] text-ink-3">{hint ?? (readOnlyRisk ? "Risk labels come from the extension's manifest." : "Labels come from the server's own hints. Click one to change it.")}</span>
      </div>
      {tools.length === 0 && <span className="text-[12px] text-ink-3">No tools listed.</span>}
      <ul className="m-0 p-0 list-none flex flex-col gap-1.5" aria-label={heading}>
        {tools.map((t, i) => (
          <li key={t.name} className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md bg-panel border border-line">
            {onChange ? <CheckButton checked={t.enabled} onChange={(v) => set(i, { enabled: v })} label={`Allow ${t.name}`} /> : null}
            <span className={cn('flex-1 min-w-0 font-mono text-[12px] truncate', t.enabled ? 'text-ink' : 'text-ink-3')}>{t.name}</span>
            {t.description && <span className="text-[11.5px] text-ink-3 truncate max-w-[45%]">{t.description}</span>}
            <RiskPill risk={t.risk} toolName={t.name} onToggle={onChange && !readOnlyRisk ? () => set(i, { risk: t.risk === 'read' ? 'ask' : 'read' }) : undefined} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Monogram({ name, size = 40 }: { name: string; size?: 40 | 52 }) {
  return (
    <span
      aria-hidden="true"
      className={cn('shrink-0 flex items-center justify-center text-on-accent font-bold', size === 40 ? 'w-10 h-10 rounded-lg text-[15px]' : 'w-[52px] h-[52px] rounded-xl text-[20px]')}
      style={{ background: tintFor(name) }}
    >
      {monogram(name)}
    </span>
  );
}

export type SavedTo = 'my-settings' | 'project-mcp-json';

const inp = 'h-[34px] px-2.5 rounded-md border border-line-3 bg-chrome text-ink text-[13px] outline-none focus:border-accent box-border min-w-0';
export const inputClass = inp;

/** Name + "Save it in" + "Turn on for", shared by every Add custom route. */
export function SaveFields({ name, onName, nameError, savedTo, onSavedTo, projects, selected, onSelected, showName = true }: {
  name?: string;
  onName?: (v: string) => void;
  nameError?: string;
  savedTo: SavedTo;
  onSavedTo: (v: SavedTo) => void;
  projects: Project[];
  selected: string[];
  onSelected: (ids: string[]) => void;
  showName?: boolean;
}) {
  const nameId = useId();
  const saveId = useId();
  return (
    <>
      <div className="flex gap-3.5 flex-wrap">
        {showName && (
          <div className="flex-[1_1_200px] flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-[12px] text-ink-2">Name</label>
            <input
              id={nameId}
              type="text"
              className={cn(inp, nameError && 'border-bad-line')}
              value={name ?? ''}
              onChange={(e) => onName?.(e.target.value)}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${nameId}-err` : undefined}
            />
            {nameError && <span id={`${nameId}-err`} className="text-[12px] text-bad">{nameError}</span>}
          </div>
        )}
        <div className="flex-[1_1_260px] flex flex-col gap-1.5">
          <label htmlFor={saveId} className="text-[12px] text-ink-2">Save it in</label>
          <select id={saveId} className={inp} value={savedTo} onChange={(e) => onSavedTo(e.target.value as SavedTo)}>
            <option value="my-settings">My settings (all my projects)</option>
            <option value="project-mcp-json">Project .mcp.json (shared through git)</option>
          </select>
        </div>
      </div>
      <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5">
        <legend className="text-[12px] text-ink-2 mb-1.5 p-0">Turn on for</legend>
        <div className="flex gap-3.5 flex-wrap">
          {projects.length === 0 && <span className="text-[12px] text-ink-3">Open a project first.</span>}
          {projects.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                className="accent-accent"
                checked={selected.includes(p.id)}
                onChange={(e) => onSelected(e.target.checked ? [...selected, p.id] : selected.filter((x) => x !== p.id))}
              />
              {p.name}
            </label>
          ))}
        </div>
        {savedTo === 'project-mcp-json' && (
          <span className="text-[12px] text-ink-3">oIDE writes the server into each chosen project's .mcp.json with ${'{VAR}'} placeholders; secrets stay in your keychain.</span>
        )}
      </fieldset>
    </>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal shell for the Add custom dialog (720px, 56px from the top, as designed): role=dialog,
 * aria-modal, labelled by its title, focus moves in and is trapped, Esc closes, focus returns
 * to the opener, and a modal keymap scope blocks the screen's shortcuts underneath.
 * `dismissOnScrim={false}` stops a click on the backdrop from closing it (use it once the form holds
 * input); Esc, Close and Cancel still do. Only a press that starts on the backdrop itself counts, so
 * a drag that begins inside the dialog and ends outside never closes it.
 */
export function ModalShell({ title, description, onClose, children, footer, tabs, width = 720, dismissOnScrim = true }: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  tabs?: ReactNode;
  width?: number;
  dismissOnScrim?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useKeymapScope('marketplace-add-custom', {}, { modal: true });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? ref.current)?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-scrim flex items-start justify-center pt-14 px-4 pb-4 box-border overflow-auto"
      onMouseDown={(e) => {
        if (dismissOnScrim && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-w-full flex flex-col bg-card border border-line-3 rounded-3xl shadow-dialog overflow-hidden outline-none"
        style={{ width }}
      >
        <div className="flex items-center gap-3 px-5 pt-4 pb-3">
          <div className="flex-1 flex flex-col gap-[3px] min-w-0">
            <h2 id={titleId} className="m-0 text-[16px] font-semibold">{title}</h2>
            {description && <span id={descId} className="text-[12.5px] text-ink-3">{description}</span>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="w-[30px] h-[30px] rounded-[7px] border-0 bg-transparent text-ink-3 hover:bg-raised hover:text-ink flex items-center justify-center">
            <Icon name="close" size={16} />
          </button>
        </div>
        {tabs}
        <div className="flex flex-col gap-3.5 px-5 py-4 max-h-[calc(100vh-240px)] overflow-auto">{children}</div>
        <div className="flex items-center gap-2 px-5 py-3 border-t border-line-2 bg-panel">{footer}</div>
      </div>
    </div>
  );
}
