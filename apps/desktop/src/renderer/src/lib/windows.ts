import { ipcErrorMessage, oide } from './bridge';
import { toast } from '../stores/ui';

/**
 * Another oIDE window on the same profile (docs/wiki/pages/windows.md): same projects, agents and
 * settings; its own screen, focused agent and project scope.
 */
export async function openNewWindow(from: 'shortcut' | 'command'): Promise<void> {
  try {
    await oide.invoke('app.newWindow', { from });
  } catch (err) {
    toast(ipcErrorMessage(err), 'error');
  }
}
