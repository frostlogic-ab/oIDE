import type { ReactNode, SVGProps } from 'react';
import { cn } from './cn.js';

/**
 * Stroke icons from the Mission Control canvas (viewBox 24, stroke 1.7, round caps/joins).
 * Paths are copied from docs/wiki/raw/design/*.dc.html. Names marked "extra" are not on the
 * canvas but follow the same style. Never use emoji for icons.
 */
const P = {
  /** Rail: Agents (wall). */
  agents: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  /** Rail: Artifacts; also "Attach artifact" and artifact context chips. */
  artifacts: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  /** Rail: Files; also file rows and file context chips. */
  file: (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  /** Rail: Source control. */
  'source-control': (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10" />
      <path d="M18 10c0 4-6 3-12 7" />
    </>
  ),
  /** Rail: Extension marketplace. */
  marketplace: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
      <path d="M17 3v8" />
      <path d="M13 7h8" />
    </>
  ),
  /** Rail: Settings. */
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  'chevron-left': <path d="M15 6l-6 6 6 6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  terminal: (
    <>
      <path d="M4 6l6 6-6 6" />
      <path d="M12 18h8" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  'alert-circle': (
    <>
      <path d="M12 8v5M12 16.5v.5" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  'arrow-up': (
    <>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </>
  ),
  'arrow-down': (
    <>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  /** "All projects" scope row. */
  projects: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  /** Subagent row on tiles. */
  subagents: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 7v10" />
      <path d="M6 9c0 3 4 3 10 3" />
    </>
  ),
  // ---- extra (not on the canvas, same style) ----
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-up': <path d="M6 15l6-6 6 6" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  play: <path d="M7 5l12 7-12 7z" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  'external-link': (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>
  ),
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </>
  ),
  /** Extra: Archive / Archived agents (a box with a lid). */
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  /** Extra: "Attach file" on prompt inputs (Focus composer, Wall reply, Spawn goal). */
  paperclip: <path d="M20.5 11.5l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />,
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="7" r="2" />
      <path d="M6 7v10" />
      <path d="M18 9c0 5-12 3-12 8" />
    </>
  ),
  /** Files tree: collapse every folder. */
  'collapse-all': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12h8" />
    </>
  ),
  /** Files tree: expand the loaded folders. */
  'expand-all': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12h8M12 8v8" />
    </>
  ),
  /** Files tree: reveal the active file. */
  locate: (
    <>
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </>
  ),
  /** Extra: Files tree › New file. */
  'file-plus': (
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  /** Extra: Files tree › New folder. */
  'folder-plus': (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  /** Extra: Rename. */
  pencil: (
    <>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  /** Extra: Cut. */
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.1 8.1L20 20M8.1 15.9L20 4" />
    </>
  ),
  /** Extra: Paste. */
  clipboard: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
    </>
  ),
  /** Files search: replace. */
  replace: (
    <>
      <path d="M4 7h11" />
      <path d="M12 4l3 3-3 3" />
      <path d="M20 17H9" />
      <path d="M12 14l-3 3 3 3" />
    </>
  ),
  /** Files search: replace all. */
  'replace-all': (
    <>
      <path d="M4 5h11" />
      <path d="M12 2l3 3-3 3" />
      <path d="M4 11h11" />
      <path d="M20 19H9" />
      <path d="M12 16l-3 3 3 3" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof P;
export const ICON_NAMES = Object.keys(P) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Pixel size (width and height). Default 18 (rail, header); canvas also uses 13–16. */
  size?: number;
  /** When set, the icon is announced with this label instead of being aria-hidden. */
  title?: string;
}

export function Icon({ name, size = 18, title, className, style, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cn('ico', className)}
      style={{ width: size, height: size, ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      {P[name]}
    </svg>
  );
}
