/**
 * A full-screen extension panel (`contributes.panels` with `location: "screen"`, or an inspector
 * panel opened without an agent). Reached from its rail button, the command bar ("Open <title>")
 * or the extension's own `ctx.panels.open`.
 */
import { Button, EmptyState } from '@oide/ui';
import { HeaderSlot } from '../../components/frame/HeaderSlot';
import { ExtensionFrame } from '../../extensions/ExtensionFrame';
import { findPanel } from '../../extensions/model';
import { useExtensions } from '../../extensions/store';
import { navigate, useRouter } from '../../stores/router';

export default function ExtensionScreen() {
  const route = useRouter((s) => s.route);
  const params = route.screen === 'extension' ? route.params : undefined;
  const installed = useExtensions((s) => s.installed);
  const loaded = useExtensions((s) => s.loaded);
  const panel = params ? findPanel(installed, params.extension, params.panelId) : undefined;

  return (
    <main
      aria-label={panel ? `${panel.title} (${panel.displayName})` : 'Extension panel'}
      className="flex-1 min-w-0 min-h-0 flex flex-col bg-panel"
    >
      <HeaderSlot name="title">
        <span className="flex items-center gap-1.5 text-[12.5px] whitespace-nowrap">
          <span className="text-ink-3">{panel?.displayName ?? 'Extension'}</span>
          <span aria-hidden="true" className="text-ink-4">
            /
          </span>
          <span className="text-ink">{panel?.title ?? 'Panel'}</span>
        </span>
      </HeaderSlot>
      {panel ? (
        <ExtensionFrame
          key={`${panel.extension}:${panel.id}`}
          extension={panel.extension}
          kind="panel"
          id={panel.id}
          title={panel.title}
        />
      ) : (
        loaded && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <EmptyState
              icon="info"
              title="This panel is not available"
              description="Its extension was turned off or removed."
            />
            <Button size={32} onClick={() => navigate('marketplace', {})}>
              Open Marketplace
            </Button>
          </div>
        )
      )}
    </main>
  );
}
