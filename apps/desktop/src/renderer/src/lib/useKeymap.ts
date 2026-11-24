import { useEffect, useRef, useSyncExternalStore } from 'react';
import { keymap, type ActionId, type ScopeHandlers } from './keymap';

/**
 * Activate a keymap scope while the component is mounted:
 *
 *   useKeymapScope('wall', { 'agent.nextNeedsYou': () => jumpToNext() });
 *
 * Handlers may change every render; the latest are used. `modal: true` (dialogs, command bar)
 * stops keys from reaching scopes underneath.
 */
export function useKeymapScope(id: string, handlers: ScopeHandlers, opts: { modal?: boolean; enabled?: boolean } = {}): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  const enabled = opts.enabled ?? true;
  const modal = opts.modal ?? false;
  const actions = Object.keys(handlers).sort().join('|');

  useEffect(() => {
    if (!enabled) return;
    const proxied: ScopeHandlers = {};
    for (const action of actions.split('|').filter(Boolean)) {
      proxied[action] = (e) => ref.current[action]?.(e);
    }
    return keymap.pushScope(id, proxied, { modal });
  }, [id, actions, enabled, modal]);
}

/** Display label for an action's first binding ("Ctrl K"); re-renders on rebind. */
export function useShortcutLabel(action: ActionId): string {
  return useSyncExternalStore(
    (cb) => keymap.onChange(cb),
    () => keymap.label(action),
  );
}
