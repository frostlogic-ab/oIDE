import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Dialog, Kbd } from '@oide/ui';
import { ACTION_LABELS, DEFAULT_BINDINGS, comboFromEvent, comboLabel, keymap, portableCombo, type Keymap } from '../../lib/keymap';
import { H1, Rd, Row, Sec, describedBy, outlineBtn } from './ui';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph']);

const labelOf = (action: string) => ACTION_LABELS[action] ?? action.replace(/^ext:/, 'Extension: ');

/** Re-render when any binding changes (rebind here, settings.changed from another window). */
function useKeymapVersion(km: Keymap): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => km.onChange(bump), [km]);
}

/**
 * Settings › Keyboard shortcuts. Change records the next key combo (Esc cancels); a combo another
 * action already uses shows a warning and saving takes it from that action. Reset goes back to the
 * built-in keys. Rebinds are saved in Settings (`keybindings`), see lib/keybindings.ts.
 */
export function KeysSection({ km = keymap }: { km?: Keymap }) {
  useKeymapVersion(km);
  const mac = km.mac;
  const bindings = km.getBindings();
  const actions = Object.keys({ ...DEFAULT_BINDINGS, ...bindings });
  const [recording, setRecording] = useState<{ action: string; combo?: string } | null>(null);
  const customCount = actions.filter((a) => km.isCustom(a)).length;
  const anyCustom = customCount > 0;
  const [confirmReset, setConfirmReset] = useState(false);

  // Each action's Change button, so focus can go back to it when recording ends (Save, Cancel, Esc).
  const changeButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusTo = useRef<string | null>(null);
  useEffect(() => {
    if (recording) {
      returnFocusTo.current = recording.action;
      return;
    }
    const action = returnFocusTo.current;
    returnFocusTo.current = null;
    if (action) changeButtons.current.get(action)?.focus();
  }, [recording]);

  const onRecordKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!recording) return;
    // A plain Tab is never recorded: it moves focus on to Save/Cancel so the keyboard is not trapped.
    // Shift+Tab stays recordable because it is a real shortcut (Switch permission mode).
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return;
    // Keep the key away from the app's own shortcuts while recording.
    e.preventDefault();
    e.stopPropagation();
    if (MODIFIER_KEYS.has(e.key)) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      setRecording(null);
      return;
    }
    setRecording({ action: recording.action, combo: portableCombo(comboFromEvent(e.nativeEvent), mac) });
  };

  return (
    <>
      <H1>Keyboard shortcuts</H1>
      <Rd>
        Shortcuts work in the oIDE window only, never system-wide. Single keys are ignored while you type in a field. Choose Change, then press the new keys.
      </Rd>
      <Sec>Shortcuts</Sec>
      {actions.map((action) => {
        const combos = bindings[action] ?? [];
        const custom = km.isCustom(action);
        const rec = recording?.action === action ? recording : null;
        const clash = rec?.combo ? km.conflicts(rec.combo, action) : [];
        const title = labelOf(action);
        return (
          <Row
            key={action}
            title={title}
            desc={custom ? `Changed · default ${km.defaultsFor(action).map((c) => comboLabel(c, mac)).join(', ') || 'none'}` : undefined}
            error={
              clash.length > 0 && rec?.combo ? (
                <>
                  {comboLabel(rec.combo, mac)} is already used for {clash.map(labelOf).join(', ')}. Saving takes it from there.
                </>
              ) : undefined
            }
          >
            {({ titleId, errorId }) =>
              rec ? (
                <span
                  className="flex items-center gap-1.5 flex-wrap justify-end"
                  onKeyDown={(e) => {
                    // Esc still cancels after Tab moved focus on to Save / Cancel (the recorder stops its own keys).
                    if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setRecording(null);
                  }}
                >
                  <button
                    type="button"
                    autoFocus
                    onKeyDown={onRecordKey}
                    aria-label={`New shortcut for ${title}`}
                    aria-describedby={describedBy(`${titleId}-rec`, errorId)}
                    className="h-[30px] min-w-[120px] px-3 rounded-[7px] border border-accent bg-card text-ink text-[12.5px] font-mono"
                    data-testid={`record-${action}`}
                  >
                    {rec.combo ? comboLabel(rec.combo, mac) : 'Press keys…'}
                  </button>
                  <span id={`${titleId}-rec`} className="basis-full text-right text-[11.5px] text-ink-2 order-last">
                    Press the new keys · Tab to move on · Esc to cancel
                  </span>
                  <button
                    type="button"
                    className={outlineBtn}
                    disabled={!rec.combo}
                    onClick={() => {
                      if (!rec.combo) return;
                      km.assign(action, rec.combo);
                      setRecording(null);
                    }}
                  >
                    Save
                  </button>
                  <button type="button" className={outlineBtn} onClick={() => setRecording(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <span className="flex items-center gap-1.5 flex-wrap justify-end">
                  {combos.length === 0 && <span className="text-[12px] text-ink-3">Not set</span>}
                  {combos.map((c) => (
                    <Kbd key={c} className="text-[12px] px-2 py-0.5">
                      {comboLabel(c, mac)}
                    </Kbd>
                  ))}
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) changeButtons.current.set(action, el);
                      else changeButtons.current.delete(action);
                    }}
                    className={outlineBtn}
                    aria-label={`Change shortcut for ${title}`}
                    onClick={() => setRecording({ action })}
                  >
                    Change
                  </button>
                  {custom && (
                    <button type="button" className={outlineBtn} aria-label={`Reset shortcut for ${title}`} onClick={() => km.resetBinding(action)}>
                      Reset
                    </button>
                  )}
                </span>
              )
            }
          </Row>
        );
      })}
      {anyCustom && (
        <div className="mt-4">
          <button type="button" className={outlineBtn} onClick={() => setConfirmReset(true)}>
            Reset all shortcuts
          </button>
        </div>
      )}
      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset all shortcuts?"
        description={`${customCount} ${customCount === 1 ? 'shortcut goes' : 'shortcuts go'} back to oIDE's defaults.`}
        footer={
          <>
            <Button size={32} onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              size={32}
              variant="danger"
              onClick={() => {
                km.resetBinding();
                setConfirmReset(false);
              }}
            >
              Reset all
            </Button>
          </>
        }
      />

    </>
  );
}
