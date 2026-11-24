import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState, Spinner, cn } from '@oide/ui';
import { invokeOr, ipcErrorMessage } from '../lib/bridge';
import { frameLoaded, registerFrame, type FrameEntry } from './panelBridge';
import { useExtensions } from './store';

export interface ExtensionFrameProps {
  extension: string;
  kind: 'panel' | 'artifactType';
  /** Panel id or artifact type id. */
  id: string;
  /** Accessible name of the iframe (the panel title). */
  title: string;
  /** Sent to the frame as `{ type: 'oide:context', … }` when it loads (agent, project, artifact id). */
  context?: Record<string, unknown>;
  onAppMessage?: FrameEntry['onAppMessage'];
  /** Gets the frame's bridge entry (artifact viewers post their artifact through it). */
  onEntry?(entry: FrameEntry | null): void;
  /** The frame (re)loaded, after its context was sent. */
  onLoad?(): void;
  className?: string;
}

/**
 * An extension panel or artifact viewer: `<iframe sandbox="allow-scripts">` (no `allow-same-origin`,
 * no forms, popups or top navigation) on an `oide-ext://` URL that main serves from the extension's
 * folder with a no-network CSP. It talks to the app only through the panel bridge (panelBridge.ts).
 */
export function ExtensionFrame({
  extension,
  kind,
  id,
  title,
  context,
  onAppMessage,
  onEntry,
  onLoad,
  className,
}: ExtensionFrameProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLIFrameElement>(null);
  const loadedRef = useRef(false);
  const host = useExtensions((s) => s.hostState[extension]);
  const handler = useRef(onAppMessage);
  handler.current = onAppMessage;
  const ctxKey = JSON.stringify(context ?? null);

  useEffect(() => {
    let live = true;
    loadedRef.current = false;
    setUrl(null);
    setError(null);
    invokeOr('extensions.uiUrl', { extension, kind, id }, null).then(
      (r) => {
        if (!live) return;
        if (r?.url) setUrl(r.url);
        else setError('This build cannot show extension panels.');
      },
      (err: unknown) => live && setError(ipcErrorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [extension, kind, id]);

  const entry = useMemo<FrameEntry>(
    () => ({
      win: () => ref.current?.contentWindow ?? null,
      extension,
      id,
      kind,
      ...(context ? { context } : {}),
      onAppMessage: (d) => handler.current?.(d),
    }),
    // context is compared by value (ctxKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [extension, id, kind, ctxKey],
  );

  useEffect(() => {
    const off = registerFrame(entry);
    // A new context for a frame that already loaded: send it now.
    if (loadedRef.current) frameLoaded(entry);
    onEntry?.(entry);
    return () => {
      off();
      onEntry?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);

  if (error)
    return (
      <EmptyState
        icon="alert-circle"
        title="This panel could not load"
        description={error}
        className="py-10"
      />
    );

  return (
    <div className={cn('relative flex-1 min-h-0 flex flex-col', className)}>
      {(host?.state === 'reloading' || host?.state === 'failed') && (
        <div
          role="status"
          className={cn(
            'px-3 py-1.5 text-[12px] border-b',
            host.state === 'failed'
              ? 'text-bad bg-bad-bg border-bad-line'
              : 'text-warn bg-warn-bg border-warn-line',
          )}
        >
          {host.state === 'failed'
            ? `Its host code stopped${host.error ? `: ${host.error}` : ''}.`
            : 'Its host code is reloading…'}
        </div>
      )}
      {!url ? (
        <div className="flex-1 flex items-center justify-center">
          <Spinner size={14} />
        </div>
      ) : (
        <iframe
          ref={ref}
          key={url}
          src={url}
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => {
            loadedRef.current = true;
            frameLoaded(entry);
            onLoad?.();
          }}
          className="flex-1 min-h-0 w-full border-0 bg-panel"
        />
      )}
    </div>
  );
}
