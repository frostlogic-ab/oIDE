import type { InstalledExtension } from '@oide/protocol';
import type { Command } from '../lib/commands';
import { useSettings } from '../stores/settings';
import { toast } from '../stores/ui';
import { isOnSomewhere, nextTheme, themeOptions } from './model';
import { openPanel } from './store';

/**
 * Command bar entries for extension UI: "Open <panel>" for every contributed panel (inspector panels
 * open in the agent shown in Focus, otherwise full screen), and "Next accent colour" when
 * extensions contribute more than one theme.
 */
export function extensionUiCommands(installed: readonly InstalledExtension[]): Command[] {
  const out: Command[] = [];
  for (const e of installed) {
    if (!isOnSomewhere(e)) continue;
    for (const p of e.manifest.oide.contributes.panels) {
      out.push({
        id: `ext-panel:${e.name}:${p.id}`,
        title: `Open ${p.title}`,
        group: e.displayName,
        keywords: ['panel', 'view', e.displayName],
        run: () => openPanel(e.name, p.id),
      });
    }
  }
  const themes = themeOptions(installed);
  if (themes.length > 1) {
    out.push({
      id: 'oide.theme.next',
      title: 'Next accent colour',
      group: 'Appearance',
      keywords: ['theme', 'accent', 'color', 'colour'],
      run: async () => {
        const next = nextTheme(themes, useSettings.getState().settings?.ui.accent);
        if (!next) return;
        try {
          await useSettings.getState().update({ ui: { accent: next.value } });
          toast(`Accent: ${next.label}`);
        } catch {
          toast('Could not change the accent colour', 'error');
        }
      },
    });
  }
  return out;
}
