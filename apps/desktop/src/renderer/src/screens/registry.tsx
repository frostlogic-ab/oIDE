import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { IconName } from '@oide/ui';
import type { ScreenId } from '../stores/router';
import WallScreen from './Wall';

/**
 * Every screen and how the frame treats it. To add a screen: add its id and params to
 * `ScreenParams` in stores/router.ts, create screens/<Name>/index.tsx with a default export, and
 * add an entry here. Screens other than the Wall load lazily.
 */
/** xtension: a full-screen extension panel; the rail marks its own button (see Rail.tsx). */
export type RailItemId = 'agents' | 'artifacts' | 'files' | 'source-control' | 'marketplace' | 'settings' | 'extension';

export interface ScreenDef {
  id: ScreenId;
  /** Header title for `title` headers, and the document title. */
  title: string;
  /** Which rail item is selected (aria-current) on this screen. */
  rail: RailItemId;
  /**
   * `command`: the Wall/Focus header (command bar trigger).
   * `title`: the other screens (screen title; breadcrumbs via <HeaderSlot name="title">).
   */
  header: 'command' | 'title';
  /** Show the shared project-scope switcher in the header (Files, Source control). */
  scopeSwitcher?: boolean;
  /** The screen provides its own header title through <HeaderSlot name="title">. */
  customTitle?: boolean;
  /** Rendered as a modal over the Wall (Spawn). */
  overlay?: boolean;
  component: ComponentType | LazyExoticComponent<ComponentType>;
}

export const SCREENS: Record<ScreenId, ScreenDef> = {
  wall: { id: 'wall', title: 'Agents', rail: 'agents', header: 'command', component: WallScreen },
  focus: { id: 'focus', title: 'Focus', rail: 'agents', header: 'command', component: lazy(() => import('./Focus')) },
  spawn: { id: 'spawn', title: 'Spawn an agent', rail: 'agents', header: 'command', overlay: true, component: lazy(() => import('./Spawn')) },
  'source-control': {
    id: 'source-control',
    title: 'Source control',
    rail: 'source-control',
    header: 'title',
    scopeSwitcher: true,
    component: lazy(() => import('./SourceControl')),
  },
  review: { id: 'review', title: 'Review changes', rail: 'source-control', header: 'title', customTitle: true, component: lazy(() => import('./Review')) },
  files: { id: 'files', title: 'Files', rail: 'files', header: 'title', scopeSwitcher: true, component: lazy(() => import('./Files')) },
  artifacts: { id: 'artifacts', title: 'Artifacts', rail: 'artifacts', header: 'title', component: lazy(() => import('./Artifacts')) },
  marketplace: { id: 'marketplace', title: 'Marketplace', rail: 'marketplace', header: 'title', component: lazy(() => import('./Marketplace')) },
  settings: { id: 'settings', title: 'Settings', rail: 'settings', header: 'title', component: lazy(() => import('./Settings')) },
  extension: { id: 'extension', title: 'Extension', rail: 'extension', header: 'title', customTitle: true, component: lazy(() => import('./Extension')) },
};

export interface RailItem {
  id: RailItemId;
  label: string;
  icon: IconName;
  screen: ScreenId;
}

/** Left rail, top group then (after the spacer) bottom group, as on the canvas. */
export const RAIL_TOP: RailItem[] = [
  { id: 'agents', label: 'Agents', icon: 'agents', screen: 'wall' },
  { id: 'artifacts', label: 'Artifacts', icon: 'artifacts', screen: 'artifacts' },
  { id: 'files', label: 'Files', icon: 'file', screen: 'files' },
  { id: 'source-control', label: 'Source control', icon: 'source-control', screen: 'source-control' },
];
export const RAIL_BOTTOM: RailItem[] = [
  { id: 'marketplace', label: 'Extension marketplace', icon: 'marketplace', screen: 'marketplace' },
  { id: 'settings', label: 'Settings', icon: 'settings', screen: 'settings' },
];
