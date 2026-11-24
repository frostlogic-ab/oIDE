import { Suspense, useEffect } from 'react';
import { Spinner } from '@oide/ui';
import { SCREENS } from '../../screens/registry';
import { ScreenErrorBoundary } from '../ErrorBoundary';
import { useRouter } from '../../stores/router';
import { CommandBar } from './CommandBar';
import { Header } from './Header';
import { Rail } from './Rail';
import { StatusBar } from './StatusBar';
import { Toasts } from './Toasts';

/**
 * The app frame from the canvas: 44px header, 56px rail, screen, 26px status bar. Screens fill
 * the area between rail and the right edge (they own their sidebars and inspectors).
 */
export function AppFrame() {
  const route = useRouter((s) => s.route);
  const def = SCREENS[route.screen];
  const Base = def.overlay ? SCREENS.wall.component : def.component;
  const Overlay = def.overlay ? def.component : null;

  useEffect(() => {
    document.title = route.screen === 'wall' ? 'oIDE' : `${def.title} · oIDE`;
  }, [route.screen, def.title]);

  return (
    <div className="h-full flex flex-col bg-ground text-ink overflow-hidden">
      <Header def={def} />
      <div className="flex-1 min-h-0 flex">
        <Rail active={def.rail} />
        <div className="flex-1 min-w-0 min-h-0 flex" data-screen={route.screen}>
          <ScreenErrorBoundary screen={route.screen}>
            <Suspense fallback={<ScreenLoading />}>
              <Base />
              {Overlay && <Overlay />}
            </Suspense>
          </ScreenErrorBoundary>
        </div>
      </div>
      <StatusBar />
      <CommandBar />
      <Toasts />
    </div>
  );
}

function ScreenLoading() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Spinner />
    </div>
  );
}
