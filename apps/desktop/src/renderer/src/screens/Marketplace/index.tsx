/**
 * PLACEHOLDER: Marketplace (docs/wiki/raw/design/Marketplace.dc.html), implemented in wave 2.
 * Replace the ScreenPlaceholder with the real screen. The frame (header title,
 * rail selection, status bar) is already handled by screens/registry.tsx.
 */
import { ScreenPlaceholder } from '../../components/ScreenPlaceholder';

export default function MarketplaceScreen() {
  return (
    <ScreenPlaceholder
      title="Marketplace"
      design="Marketplace.dc.html"
      icon="marketplace"
      description="Categories, search, extension details with tool risk labels, install, per-project enable and Add custom."
    />
  );
}
