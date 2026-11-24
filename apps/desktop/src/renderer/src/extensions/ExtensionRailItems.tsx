import { useMemo } from 'react';
import { cn } from '@oide/ui';
import { navigate } from '../stores/router';
import { panelsAt } from './model';
import { useExtensions } from './store';

/**
 * Rail buttons for full-screen extension panels. Extensions contribute no icons, so each button
 * shows the panel title's first letter in an 18px outlined tile (the size of a rail icon).
 */
export function ExtensionRailItems({
  current,
}: {
  current?: { extension: string; panelId: string } | undefined;
}) {
  const installed = useExtensions((s) => s.installed);
  const screens = useMemo(() => panelsAt(installed, 'screen'), [installed]);
  if (!screens.length) return null;
  return (
    <>
      <span aria-hidden="true" className="w-6 h-px bg-line my-1" />
      {screens.map((p) => {
        const active = current?.extension === p.extension && current.panelId === p.id;
        const label = `${p.title} (${p.displayName})`;
        return (
          <button
            key={`${p.extension}:${p.id}`}
            type="button"
            aria-label={label}
            title={label}
            aria-current={active ? 'page' : undefined}
            onClick={() => navigate('extension', { extension: p.extension, panelId: p.id })}
            className={cn(
              'w-10 h-10 rounded-lg border-0 flex items-center justify-center',
              active ? 'bg-selected text-accent' : 'bg-transparent text-ink-3 hover:text-ink hover:bg-raised',
            )}
          >
            <span
              aria-hidden="true"
              className="w-[18px] h-[18px] rounded-[5px] border-[1.7px] border-current box-border flex items-center justify-center text-[10px] font-bold leading-none"
            >
              {(p.title.trim()[0] ?? '?').toUpperCase()}
            </span>
          </button>
        );
      })}
    </>
  );
}
