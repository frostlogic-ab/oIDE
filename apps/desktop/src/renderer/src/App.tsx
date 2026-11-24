import { useEffect } from 'react';
import { AppFrame } from './components/frame/AppFrame';
import { startStores } from './lib/boot';
import { useKeymapScope } from './lib/useKeymap';
import { commands } from './lib/commands';
import { useRouter } from './stores/router';
import { useUi } from './stores/ui';

export function App() {
  useEffect(() => startStores(), []);

  // App-level shortcuts; screens push their own scopes on top (wall, focus, …).
  useKeymapScope('app', {
    'commandBar.open': () => useUi.getState().openCommandBar(),
    'nav.back': () => useRouter.getState().goBack(),
    'nav.forward': () => useRouter.getState().goForward(),
    'agent.nextNeedsYou': () => void commands.run('oide.nextNeedsYou'),
  });

  return <AppFrame />;
}
