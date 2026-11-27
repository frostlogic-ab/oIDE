import { z } from 'zod';

/**
 * How a new oIDE window was opened (docs/wiki/pages/windows.md). Every window shares the same
 * profile: projects, agents, settings and extensions live in main, not in the window.
 *
 * - `shortcut`: Ctrl/Cmd+Shift+N in a window. `command`: "New window" in the command bar.
 * - `menu`: File › New Window (macOS). `dock`: the Dock menu (macOS).
 * - `taskbar`: the taskbar jump list "New window" task (Windows).
 * - `relaunch`: oIDE was started again while it was running (shortcut, Start menu, `pnpm dev`).
 */
export const WindowOpenTrigger = z.enum(['shortcut', 'command', 'menu', 'dock', 'taskbar', 'relaunch']);
export type WindowOpenTrigger = z.infer<typeof WindowOpenTrigger>;
