import { useCallback, useMemo } from 'react';
import { Icon, Kbd, Logo, SegmentedControl } from '@oide/ui';
import type { Scope } from '@oide/protocol';
import { useProjects } from '../../stores/projects';
import { useScope } from '../../stores/scope';
import { useUi } from '../../stores/ui';
import { useShortcutLabel } from '../../lib/useKeymap';
import type { ScreenDef } from '../../screens/registry';
import { UpdateButton } from './UpdateButton';
import { oide } from '../../lib/bridge';

const SITE_URL = 'https://getoide.com';

/** 44px title bar: logo (opens getoide.com in the system browser), the Update button when an update is ready, title/breadcrumb slot or command-bar trigger, scope switcher, actions slot. No agent counters: the Wall already shows them. */
export function Header({ def }: { def: ScreenDef }) {
  const setSlot = useUi((s) => s.setHeaderSlot);
  const titleRef = useCallback((el: HTMLDivElement | null) => setSlot('title', el), [setSlot]);
  const actionsRef = useCallback((el: HTMLDivElement | null) => setSlot('actions', el), [setSlot]);

  return (
    <header className="h-header shrink-0 flex items-center gap-4 px-4 border-b border-line bg-chrome">
      <button
        type="button"
        onClick={() => void oide.invoke('shell.openExternal', { url: SITE_URL }).catch(() => undefined)}
        title="Open getoide.com in your browser"
        aria-label="oIDE, open getoide.com in your browser"
        className="flex items-center gap-2 shrink-0 whitespace-nowrap rounded-md -mx-1 px-1 hover:bg-card"
      >
        <Logo size={26} />
        <span className="font-bold tracking-[-0.01em] text-[14px] text-ink leading-none">oIDE</span>
      </button>

      <UpdateButton />

      <div ref={titleRef} className="flex items-center gap-2 min-w-0 empty:hidden">
        {def.header === 'title' && !def.customTitle && <span className="text-ink text-[12.5px] whitespace-nowrap">{def.title}</span>}
      </div>

      {def.header === 'command' ? (
        <CommandTrigger />
      ) : (
        <>
          <div className="flex-1" />
          {def.scopeSwitcher && <ScopeSwitcher />}
        </>
      )}

      <div ref={actionsRef} className="flex items-center gap-2 empty:hidden" />
    </header>
  );
}

function CommandTrigger() {
  const open = useUi((s) => s.openCommandBar);
  const shortcut = useShortcutLabel('commandBar.open');
  return (
    <button
      type="button"
      onClick={() => open()}
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut.replace(' ', '+')}
      className="flex-[1_1_320px] max-w-[560px] mx-auto h-[30px] flex items-center gap-2 px-3 bg-card border border-line-2 rounded-md text-ink-3 text-[13px] text-left hover:border-line-3"
    >
      <Icon name="search" />
      <span className="flex-1 truncate">Spawn an agent, jump to a session, or run a command</span>
      <Kbd className="text-[11px]! px-1.5! py-0.5!">{shortcut}</Kbd>
    </button>
  );
}

/** Shared project scope (scopes the Wall, Files and Source control together). */
export function ScopeSwitcher() {
  const projects = useProjects((s) => s.list);
  const scope = useScope((s) => s.scope);
  const setScope = useScope((s) => s.setScope);
  const options = useMemo(
    () => [{ value: 'all' as Scope, label: 'All projects' }, ...projects.map((p) => ({ value: p.id as Scope, label: p.name }))],
    [projects],
  );
  return <SegmentedControl label="Project scope" options={options} value={scope} onChange={(s) => void setScope(s)} />;
}
