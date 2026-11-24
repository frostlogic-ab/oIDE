/**
 * PLACEHOLDER: Settings (docs/wiki/raw/design/Settings.dc.html), implemented in wave 2.
 * Replace the ScreenPlaceholder with the real screen. The frame (header title,
 * rail selection, status bar) is already handled by screens/registry.tsx.
 */
import { ScreenPlaceholder } from '../../components/ScreenPlaceholder';

export default function SettingsScreen() {
  return (
    <ScreenPlaceholder
      title="Settings"
      design="Settings.dc.html"
      icon="settings"
      description="Claude Code, Models, Agents, Techniques, Permissions and Appearance."
    />
  );
}
