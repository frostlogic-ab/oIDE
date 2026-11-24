/**
 * PLACEHOLDER: Files (docs/wiki/raw/design/Files.dc.html), implemented in wave 2.
 * Replace the ScreenPlaceholder with the real screen. The frame (header title, scope switcher,
 * rail selection, status bar) is already handled by screens/registry.tsx.
 */
import { ScreenPlaceholder } from '../../components/ScreenPlaceholder';

export default function FilesScreen() {
  return (
    <ScreenPlaceholder
      title="Files"
      design="Files.dc.html"
      icon="file"
      description="Project trees with branch or worktree menus, Monaco editor, agent-editing banner, file history with agent attribution."
    />
  );
}
