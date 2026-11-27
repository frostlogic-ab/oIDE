import type { ReactNode } from 'react';

/**
 * File-type icons for the Files tree, in the spirit of VS Code's default (Seti) icon theme: a small
 * coloured glyph per file type so a folder listing scans at a glance. Glyphs are inline SVG or short
 * monospace badges, never emoji. Colours are muted to sit on the dark panel.
 */

type Glyph = { kind: 'svg'; node: ReactNode } | { kind: 'text'; text: string; size?: number };

interface FileKind {
  glyph: Glyph;
  color: string;
}

const C = {
  blue: '#519aba',
  yellow: '#cbcb41',
  orange: '#e37933',
  red: '#cc3e44',
  pink: '#f55385',
  purple: '#a074c4',
  green: '#8dc149',
  grey: '#6d8086',
  white: '#d4d7d6',
  teal: '#4fb6be',
} as const;

const svg = (node: ReactNode): Glyph => ({ kind: 'svg', node });
const text = (t: string, size?: number): Glyph => ({ kind: 'text', text: t, size });

const G = {
  /** Down arrow (markdown, as in Seti). */
  markdown: svg(<path d="M12 5v12M7 12l5 5 5-5" />),
  info: svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </>,
  ),
  gear: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </>,
  ),
  /** Diamond (git files). */
  git: svg(
    <>
      <path d="M12 3l9 9-9 9-9-9z" />
      <path d="M10 9l4 4M12 11v4" />
    </>,
  ),
  /** Ribbon (licence, contributing). */
  ribbon: svg(
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="M9 13.5L7.5 21l4.5-2.5 4.5 2.5-1.5-7.5" />
    </>,
  ),
  clock: svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>,
  ),
  image: svg(
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M20 16l-5-5-9 8" />
    </>,
  ),
  lock: svg(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>,
  ),
  shield: svg(<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />),
  terminal: svg(<path d="M5 7l5 5-5 5M12 17h7" />),
  lines: svg(<path d="M5 7h14M5 12h14M5 17h9" />),
  database: svg(
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </>,
  ),
  /** Generic page (unknown types). */
  page: svg(
    <>
      <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
    </>,
  ),
  braces: text('{}', 9.5),
  bang: text('!', 11),
  hash: text('#', 11),
  lt: text('<>', 9),
};

const k = (glyph: Glyph, color: string): FileKind => ({ glyph, color });

/** Whole file names (lower case) that win over the extension. */
const BY_NAME: Record<string, FileKind> = {
  'package.json': k(G.braces, C.yellow),
  'package-lock.json': k(G.lock, C.grey),
  'pnpm-lock.yaml': k(G.lock, C.grey),
  'yarn.lock': k(G.lock, C.grey),
  'bun.lockb': k(G.lock, C.grey),
  '.gitignore': k(G.git, C.grey),
  '.gitattributes': k(G.git, C.grey),
  '.gitmodules': k(G.git, C.grey),
  '.editorconfig': k(G.gear, C.grey),
  '.npmrc': k(text('npm', 7), C.red),
  '.nvmrc': k(G.gear, C.green),
  '.prettierrc': k(G.braces, C.grey),
  '.prettierignore': k(G.gear, C.grey),
  '.eslintignore': k(G.gear, C.purple),
  '.env': k(G.gear, C.yellow),
  'license': k(G.ribbon, C.yellow),
  'license.md': k(G.ribbon, C.yellow),
  'license.txt': k(G.ribbon, C.yellow),
  'readme.md': k(G.info, C.blue),
  'readme': k(G.info, C.blue),
  'changelog.md': k(G.clock, C.blue),
  'contributing.md': k(G.ribbon, C.red),
  'security.md': k(G.shield, C.blue),
  'code_of_conduct.md': k(G.markdown, C.blue),
  'dockerfile': k(text('D', 10), C.blue),
  'makefile': k(G.terminal, C.orange),
};

const BY_EXT: Record<string, FileKind> = {
  ts: k(text('TS', 8), C.blue),
  mts: k(text('TS', 8), C.blue),
  cts: k(text('TS', 8), C.blue),
  tsx: k(text('TSX', 6.5), C.blue),
  js: k(text('JS', 8), C.yellow),
  mjs: k(text('JS', 8), C.yellow),
  cjs: k(text('JS', 8), C.yellow),
  jsx: k(text('JSX', 6.5), C.yellow),
  json: k(G.braces, C.yellow),
  jsonc: k(G.braces, C.yellow),
  json5: k(G.braces, C.yellow),
  md: k(G.markdown, C.blue),
  mdx: k(G.markdown, C.orange),
  yaml: k(G.bang, C.purple),
  yml: k(G.bang, C.purple),
  toml: k(G.gear, C.grey),
  ini: k(G.gear, C.grey),
  css: k(G.hash, C.blue),
  scss: k(G.hash, C.pink),
  less: k(G.hash, C.blue),
  html: k(G.lt, C.orange),
  htm: k(G.lt, C.orange),
  xml: k(G.lt, C.orange),
  svg: k(G.image, C.yellow),
  png: k(G.image, C.purple),
  jpg: k(G.image, C.purple),
  jpeg: k(G.image, C.purple),
  gif: k(G.image, C.purple),
  webp: k(G.image, C.purple),
  ico: k(G.image, C.purple),
  sh: k(G.terminal, C.green),
  bash: k(G.terminal, C.green),
  zsh: k(G.terminal, C.green),
  ps1: k(G.terminal, C.blue),
  bat: k(G.terminal, C.green),
  cmd: k(G.terminal, C.green),
  py: k(text('py', 8), C.blue),
  rs: k(text('rs', 8), C.orange),
  go: k(text('go', 8), C.blue),
  java: k(text('J', 10), C.red),
  kt: k(text('K', 10), C.orange),
  rb: k(text('rb', 8), C.red),
  php: k(text('php', 6.5), C.purple),
  c: k(text('C', 10), C.blue),
  h: k(text('h', 10), C.purple),
  cpp: k(text('C++', 6.5), C.blue),
  cs: k(text('C#', 8), C.blue),
  swift: k(text('sw', 8), C.orange),
  sql: k(G.database, C.pink),
  db: k(G.database, C.pink),
  sqlite: k(G.database, C.pink),
  lock: k(G.lock, C.grey),
  txt: k(G.lines, C.white),
  log: k(G.lines, C.grey),
  csv: k(G.lines, C.green),
  env: k(G.gear, C.yellow),
  vue: k(text('V', 10), C.green),
  svelte: k(text('S', 10), C.red),
};

const DEFAULT: FileKind = k(G.page, C.grey);

/** Icon kind for a file name (exact name, then `*.config.*`-style names, then extension). */
export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase();
  const exact = BY_NAME[lower];
  if (exact) return exact;
  if (lower.startsWith('.env')) return BY_NAME['.env']!;
  if (lower.startsWith('.prettierrc')) return BY_NAME['.prettierrc']!;
  if (lower.startsWith('tsconfig') && lower.endsWith('.json')) return k(G.braces, C.blue);
  if (lower.startsWith('eslint.config') || lower.startsWith('.eslintrc')) return k(text('ES', 8), C.purple);
  if (lower.startsWith('dockerfile')) return BY_NAME['dockerfile']!;
  if (/^(vite|vitest|turbo|electron\.vite|playwright|tailwind)\.config\./.test(lower)) {
    // Config files keep their language icon but read as configuration.
    const ext = lower.slice(lower.lastIndexOf('.') + 1);
    return BY_EXT[ext] ?? k(G.gear, C.grey);
  }
  const dot = lower.lastIndexOf('.');
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    if (lower.endsWith('.d.ts')) return k(text('TS', 8), C.teal);
    return BY_EXT[ext] ?? DEFAULT;
  }
  return DEFAULT;
}

/** 16px file-type icon, decorative (the row's label carries the name). */
/** `dim`: a git-ignored file (greyed out in the tree, VS Code style). */
export function FileIcon({ name, dim }: { name: string; dim?: boolean }) {
  const { glyph, color } = fileKind(name);
  return (
    <span aria-hidden="true" className={`w-4 h-4 shrink-0 flex items-center justify-center ${dim ? 'opacity-50' : ''}`} style={{ color }}>
      {glyph.kind === 'svg' ? (
        <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          {glyph.node}
        </svg>
      ) : (
        <span className="font-mono font-bold leading-none tracking-[-0.04em]" style={{ fontSize: glyph.size ?? 9 }}>
          {glyph.text}
        </span>
      )}
    </span>
  );
}
