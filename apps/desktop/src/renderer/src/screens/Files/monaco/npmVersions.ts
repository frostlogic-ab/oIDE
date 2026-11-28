/**
 * Files › package.json dependency versions (wiki: screen-files.md › Dependency versions). While a
 * package.json is the editor's model, each registry dependency gets an inline hint after its
 * version: `↑ 5.4.0` when the registry has a newer one (amber for a major upgrade), a dim `latest`
 * when it is current, nothing for packages the public registry does not have. Hovering the version
 * shows the details; clicking an `↑` hint, or the context menu's "Upgrade with an agent" on its
 * line, asks to start an agent that upgrades the package (`onUpgrade` opens Spawn, prefilled).
 *
 * The lookups go through main (`deps.latest`, cached there); this side only parses the text.
 */
import { oide } from '../../../lib/bridge';
import { useSettings } from '../../../stores/settings';
import { findDependencies, hintFor, isPackageJson, parseSpec, type DependencyEntry, type DependencyHint, type DependencySpec, type UpgradeRequest } from '../dependencies';
import { docOfUri } from './lsp';
import { monaco } from './setup';

/** Re-read the file this long after the last keystroke. */
const REFRESH_DEBOUNCE_MS = 600;
const MAX_NAMES = 500;

interface Hint {
  entry: DependencyEntry;
  spec: DependencySpec;
  hint: DependencyHint;
  /** The package.json, relative to its checkout. */
  path: string;
}

/** What a hint's injected text carries, so a click on it finds its hint. */
interface HintMark {
  oideDependencyHint: number;
}
const isMark = (v: unknown): v is HintMark => typeof v === 'object' && v !== null && typeof (v as HintMark).oideDependencyHint === 'number';

const npmUrl = (name: string) => `https://www.npmjs.com/package/${name}`;

function toRequest(h: Hint): UpgradeRequest | undefined {
  if (h.hint.kind !== 'update') return undefined;
  return { path: h.path, name: h.entry.name, lookup: h.spec.lookup, section: h.entry.section, spec: h.entry.spec, to: h.hint.version, bump: h.hint.bump };
}

function hover(h: Hint): monaco.IMarkdownString {
  const name = h.spec.lookup;
  const lines =
    h.hint.kind === 'update'
      ? [
          `**${name}** · latest **${h.hint.version}**${h.hint.bump === 'major' ? ' (major)' : ''}`,
          '',
          `package.json asks for \`${h.entry.spec}\`. Click the ↑ hint to start an agent that reads the changelog and upgrades it.`,
        ]
      : [`**${name}** · \`${h.entry.spec}\` is the latest (${h.hint.version})`];
  return { value: [...lines, '', `[Open on npm](${npmUrl(name)})`].join('\n') };
}

function decoration(h: Hint, index: number): monaco.editor.IModelDeltaDecoration {
  const { entry, hint } = h;
  const cls = hint.kind === 'latest' ? 'oide-dep-hint oide-dep-hint-latest' : `oide-dep-hint oide-dep-hint-update${hint.bump === 'major' ? ' oide-dep-hint-major' : ''}`;
  return {
    range: new monaco.Range(entry.line, entry.startColumn, entry.line, entry.endColumn),
    options: {
      hoverMessage: hover(h),
      after: {
        content: hint.kind === 'latest' ? '  latest' : `  ↑ ${hint.version}`,
        inlineClassName: cls,
        cursorStops: monaco.editor.InjectedTextCursorStops.None,
        attachedData: { oideDependencyHint: index } satisfies HintMark,
      },
    },
  };
}

/**
 * Hints for `editor`'s package.json models. `onUpgrade` gets the package to upgrade and how it was
 * asked for (a click on the hint, or the context menu).
 */
export function attachNpmVersions(editor: monaco.editor.IStandaloneCodeEditor, onUpgrade: (u: UpgradeRequest, via: 'click' | 'menu') => void): monaco.IDisposable {
  const decorations = editor.createDecorationsCollection();
  const canUpgrade = editor.createContextKey<boolean>('oideDependencyUpdate', false);
  let hints: Hint[] = [];
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    hints = [];
    decorations.clear();
    canUpgrade.set(false);
  };

  /** The update hint on the cursor's line, if any. */
  const atCursor = (): Hint | undefined => {
    const line = editor.getPosition()?.lineNumber;
    return line === undefined ? undefined : hints.find((h) => h.entry.line === line && h.hint.kind === 'update');
  };

  // Hints follow edits (decorations move with the text); their lines are read back from them.
  const syncLines = () => {
    const model = editor.getModel();
    if (!model) return;
    decorations.getRanges().forEach((r, i) => {
      const h = hints[i];
      if (h) h.entry = { ...h.entry, line: r.startLineNumber, startColumn: r.startColumn, endColumn: r.endColumn };
    });
  };

  const run = async () => {
    const my = ++seq;
    const model = editor.getModel();
    const doc = model ? docOfUri(model.uri) : undefined;
    if (!model || !doc || !isPackageJson(doc.path) || useSettings.getState().settings?.editor.npmVersions === false) return clear();
    const found: Array<{ entry: DependencyEntry; spec: DependencySpec }> = [];
    for (const entry of findDependencies(model.getValue())) {
      const spec = parseSpec(entry.name, entry.spec);
      if (spec) found.push({ entry, spec });
    }
    const names = [...new Set(found.map((f) => f.spec.lookup))].slice(0, MAX_NAMES);
    if (!names.length) return clear();
    const versionId = model.getVersionId();
    const res = await oide.invoke('deps.latest', { root: doc.root, path: doc.path, names }).catch(() => null);
    if (my !== seq || editor.getModel() !== model || model.isDisposed()) return;
    // Typed meanwhile: the positions are stale, the next run (already scheduled) redraws.
    if (model.getVersionId() !== versionId) return;
    if (!res || res.status !== 'ok') return clear();
    const next: Hint[] = [];
    for (const f of found) {
      const v = res.packages[f.spec.lookup];
      const hint = v ? hintFor(f.spec, v) : null;
      if (hint) next.push({ ...f, hint, path: doc.path });
    }
    hints = next;
    decorations.set(next.map(decoration));
    canUpgrade.set(Boolean(atCursor()));
  };

  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
  };

  const subs: monaco.IDisposable[] = [
    editor.onDidChangeModel(() => {
      clear();
      seq++;
      schedule(0);
    }),
    editor.onDidChangeModelContent(() => {
      syncLines();
      schedule(REFRESH_DEBOUNCE_MS);
    }),
    editor.onDidChangeCursorPosition(() => canUpgrade.set(Boolean(atCursor()))),
    editor.onMouseDown((e) => {
      if (!e.event.leftButton || e.event.ctrlKey || e.event.metaKey || e.event.shiftKey || e.event.altKey) return;
      // Injected text carries its options (with `attachedData`) on the mouse target at run time.
      const data = ((e.target as { detail?: unknown }).detail as { injectedText?: { options?: { attachedData?: unknown } } } | undefined)?.injectedText?.options?.attachedData;
      if (!isMark(data)) return;
      syncLines();
      const req = hints[data.oideDependencyHint] && toRequest(hints[data.oideDependencyHint]!);
      if (!req) return;
      e.event.preventDefault();
      e.event.stopPropagation();
      onUpgrade(req, 'click');
    }),
    editor.addAction({
      id: 'oide.upgradeDependency',
      label: 'Upgrade this dependency with an agent',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0.5,
      precondition: 'oideDependencyUpdate',
      run: () => {
        syncLines();
        const h = atCursor();
        const req = h && toRequest(h);
        if (req) onUpgrade(req, 'menu');
      },
    }),
  ];
  // Settings › Privacy › Show newer npm versions: switching it redraws at once.
  let lastSetting = useSettings.getState().settings?.editor.npmVersions;
  const offSettings = useSettings.subscribe((st) => {
    const now = st.settings?.editor.npmVersions;
    if (now === lastSetting) return;
    lastSetting = now;
    schedule(0);
  });
  schedule(0);

  return {
    dispose() {
      clearTimeout(timer);
      seq++;
      offSettings();
      subs.forEach((d) => d.dispose());
      decorations.clear();
    },
  };
}
