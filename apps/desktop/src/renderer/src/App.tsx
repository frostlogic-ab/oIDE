import { useEffect } from 'react';
import { AppFrame } from './components/frame/AppFrame';
import { TelemetryConsent } from './components/TelemetryConsent';
import { NewProjectDialog } from './components/NewProjectDialog';
import { startStores } from './lib/boot';
import { useKeymapScope } from './lib/useKeymap';
import { commands } from './lib/commands';
import { useRouter } from './stores/router';
import { useUi } from './stores/ui';
import { openNewWindow } from './lib/windows';

export function App() {
  useEffect(() => startStores(), []);

  // App-level shortcuts; screens push their own scopes on top (wall, focus, …).
  useKeymapScope('app', {
    'commandBar.open': () => useUi.getState().openCommandBar(),
    'nav.back': () => useRouter.getState().goBack(),
    'nav.forward': () => useRouter.getState().goForward(),
    'agent.nextNeedsYou': () => void commands.run('oide.nextNeedsYou'),
    'app.newWindow': () => void openNewWindow('shortcut'),
  });

  return (
    <>
      <AppFrame />
      <TelemetryConsent />
      <NewProjectDialog />
    </>
  );
}
