/**
 * The embedded Excalidraw editor for whiteboard artifacts (lazy chunk: Excalidraw loads only when a
 * whiteboard is opened). Fonts come from the app bundle (excalidraw-env.ts), never a CDN.
 *
 * - The scene comes from the artifact's Excalidraw JSON. The parent remounts this component (key)
 *   to load a different version, e.g. after an agent saved one.
 * - Every scene change is serialised with `serializeAsJSON(…, 'local')` (elements, the exported
 *   appState subset, referenced files). The first serialisation is reported as `initial`; the
 *   viewer compares later ones with it, so selecting, zooming or panning never counts as an edit.
 * - Ctrl/Cmd+S saves. Links open in the system browser (https only); embeds, AI features, file
 *   open/save and image export are off (the app saves through `artifacts.save`, and the CSP allows
 *   neither remote frames nor remote fetches).
 */
import './excalidraw-env';
import '@excalidraw/excalidraw/index.css';
import { useCallback, useMemo, useRef, type KeyboardEvent } from 'react';
import {
  Excalidraw,
  MainMenu,
  hashElementsVersion,
  restoreElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { oide } from '../../lib/bridge';
import { keepKeysInEditor } from './SourceEditor';

export interface WhiteboardEditorProps {
  /** Excalidraw JSON to load (read on mount only). */
  content: string;
  title: string;
  /** Serialised scene; `initial` is true for the first serialisation after mount (the loaded scene). */
  onChange: (json: string, initial: boolean) => void;
  onSave: () => void;
}

/**
 * Parses the stored JSON into Excalidraw's initial data. Elements are restored with
 * `refreshDimensions`, so hand-written JSON (an agent's text element without a width) renders whole.
 */
function sceneFromJson(content: string): ExcalidrawInitialDataState {
  try {
    const v = JSON.parse(content) as { elements?: unknown; appState?: unknown; files?: unknown };
    return {
      elements: Array.isArray(v.elements)
        ? restoreElements(v.elements as ExcalidrawInitialDataState['elements'], null, {
            refreshDimensions: true,
            repairBindings: true,
          })
        : [],
      appState: {
        ...(v.appState && typeof v.appState === 'object' ? (v.appState as object) : {}),
        theme: 'dark',
      } as ExcalidrawInitialDataState['appState'],
      files: v.files && typeof v.files === 'object' ? (v.files as ExcalidrawInitialDataState['files']) : {},
      scrollToContent: true,
    };
  } catch {
    return { elements: [], appState: { theme: 'dark' } };
  }
}

const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false as const,
    saveAsImage: false,
    toggleTheme: false,
    changeViewBackgroundColor: true,
    clearCanvas: true,
  },
};

export default function WhiteboardEditor({ content, title, onChange, onSave }: WhiteboardEditorProps) {
  // The parent remounts with a new key to load other content; the initial scene is read once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialData = useMemo(() => sceneFromJson(content), []);
  const reported = useRef(false);
  const lastHash = useRef<string>('');
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  const handleChange = useCallback(
    (
      elements: Parameters<typeof hashElementsVersion>[0],
      appState: Parameters<typeof serializeAsJSON>[1],
      files: Parameters<typeof serializeAsJSON>[2],
    ) => {
      // onChange fires for every pointer move and selection; serialise only when something that is
      // saved could have changed (element versions, file count, background, grid).
      const hash = `${hashElementsVersion(elements)}:${Object.keys(files).length}:${appState.viewBackgroundColor}:${appState.gridModeEnabled ? 1 : 0}`;
      if (hash === lastHash.current) return;
      lastHash.current = hash;
      const json = serializeAsJSON(elements, appState, files, 'local');
      const initial = !reported.current;
      reported.current = true;
      cb.current.onChange(json, initial);
    },
    [],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.stopPropagation();
      cb.current.onSave();
    }
  };

  return (
    <div className="oide-whiteboard w-full h-full" onKeyDownCapture={onKeyDown} onKeyDown={keepKeysInEditor}>
      <Excalidraw
        initialData={initialData}
        theme="dark"
        name={title}
        onChange={handleChange}
        UIOptions={UI_OPTIONS}
        aiEnabled={false}
        validateEmbeddable={() => false}
        handleKeyboardGlobally={false}
        autoFocus
        onLinkOpen={(element, event) => {
          event.preventDefault();
          const link = element.link ?? '';
          if (/^https:\/\//i.test(link))
            void oide.invoke('shell.openExternal', { url: link }).catch(() => {});
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
