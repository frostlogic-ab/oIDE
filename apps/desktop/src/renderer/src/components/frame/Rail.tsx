import { Icon, cn } from '@oide/ui';
import { navigate, useRouter } from '../../stores/router';
import { RAIL_BOTTOM, RAIL_TOP, type RailItem, type RailItemId } from '../../screens/registry';
import { ExtensionRailItems } from '../../extensions/ExtensionRailItems';

/** 56px activity rail. 40px items, radius 10; selected = `selected` bg, accent icon, aria-current. */
export function Rail({ active }: { active: RailItemId }) {
  const route = useRouter((s) => s.route);
  const current = route.screen === 'extension' ? route.params : undefined;
  return (
    <nav aria-label="Primary" className="w-rail shrink-0 flex flex-col items-center gap-1.5 py-3 bg-chrome border-r border-line">
      {RAIL_TOP.map((item) => (
        <RailButton key={item.id} item={item} active={item.id === active} />
      ))}
      {/* Full-screen extension panels (contributes.panels, location "screen"). */}
      <ExtensionRailItems current={current} />
      <div className="flex-1" />
      {RAIL_BOTTOM.map((item) => (
        <RailButton key={item.id} item={item} active={item.id === active} />
      ))}
    </nav>
  );
}

function RailButton({ item, active }: { item: RailItem; active: boolean }) {
  return (
    <button
      type="button"
      aria-label={item.label}
      title={item.label}
      aria-current={active ? 'page' : undefined}
      onClick={() => navigate(item.screen, {} as never)}
      className={cn(
        'w-10 h-10 rounded-lg border-0 flex items-center justify-center',
        active ? 'bg-selected text-accent' : 'bg-transparent text-ink-3 hover:text-ink hover:bg-raised',
      )}
    >
      <Icon name={item.icon} />
    </button>
  );
}
