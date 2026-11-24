/**
 * PLACEHOLDER: Source control (docs/wiki/raw/design/SourceControl.dc.html), implemented in wave 2.
 * Replace the ScreenPlaceholder with the real screen. The frame (header title, scope switcher,
 * rail selection, status bar) is already handled by screens/registry.tsx.
 */
import { ScreenPlaceholder } from '../../components/ScreenPlaceholder';

export default function SourceControlScreen() {
  return (
    <ScreenPlaceholder
      title="Source control"
      design="SourceControl.dc.html"
      icon="source-control"
      description="Per-project cards with sync state, your changes on main, agent worktrees with status and PR state, Ready to review, overlap heads-up and Push."
    />
  );
}
