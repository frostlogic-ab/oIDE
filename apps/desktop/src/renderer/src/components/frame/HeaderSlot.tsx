import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useUi, type HeaderSlotName } from '../../stores/ui';

/**
 * Render content into the app header from inside a screen:
 *
 *   <HeaderSlot name="title"><Breadcrumb … /></HeaderSlot>     // left, after the logo
 *   <HeaderSlot name="actions"><Button …/></HeaderSlot>          // right edge
 *
 * Set `customTitle: true` in screens/registry.tsx when the screen replaces the default title.
 */
export function HeaderSlot({ name, children }: { name: HeaderSlotName; children: ReactNode }) {
  const el = useUi((s) => s.headerSlots[name]);
  return el ? createPortal(children, el) : null;
}
