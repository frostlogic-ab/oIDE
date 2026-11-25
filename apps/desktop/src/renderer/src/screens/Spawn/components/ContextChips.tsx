import { useEffect, useId, useRef, useState } from 'react';
import type { ArtifactMeta, ContextChip } from '@oide/protocol';
import { Button, Chip, SegmentedControl, fieldClass } from '@oide/ui';
import { AttachFileButton, type AttachmentsState } from '../../../components/Attachments';
import { attachmentBytes, attachmentName, formatSize, imageSrc } from '../../../lib/attachments';
import { invokeOr } from '../../../lib/bridge';

type Kind = ContextChip['kind'];

export function chipLabel(c: ContextChip): string {
  if (c.kind === 'artifact') return c.title;
  if (c.kind === 'file') return c.title ?? c.path;
  return c.title ?? c.url.replace(/^https?:\/\//, '');
}

function chipKey(c: ContextChip): string {
  return c.kind === 'artifact' ? `a:${c.id}` : c.kind === 'file' ? `f:${c.path}` : `u:${c.url}`;
}

/**
 * "Context: [Main window v2] [src/shell/StatusBar.tsx] [+ Artifact, file or URL]" under the goal.
 * `attachments`: screenshots and files pasted, dropped or picked for the goal, as chips in the same row
 * (images with a thumbnail), plus the Attach file button; they go with the first message.
 */
export function ContextChips({ value, onChange, projectId, attachments }: { value: ContextChip[]; onChange: (next: ContextChip[]) => void; projectId: string; attachments?: AttachmentsState }) {
  const [adding, setAdding] = useState(false);
  const add = (c: ContextChip) => {
    if (!value.some((v) => chipKey(v) === chipKey(c))) onChange([...value, c]);
    setAdding(false);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1.5 flex-wrap items-center" role="group" aria-label="Context for the agent">
        <span className="text-[12px] text-ink-3">Context:</span>
        {value.map((c) => (
          <Chip
            key={chipKey(c)}
            icon={c.kind === 'artifact' ? 'artifacts' : c.kind === 'file' ? 'file' : 'link'}
            iconColor={c.kind === 'artifact' ? 'var(--color-link)' : undefined}
            onRemove={() => onChange(value.filter((v) => chipKey(v) !== chipKey(c)))}
            removeLabel={`Remove ${chipLabel(c)}`}
            className={c.kind === 'file' ? 'font-mono text-[11.5px]!' : undefined}
          >
            {chipLabel(c)}
          </Chip>
        ))}
        {attachments?.items.map(({ key, attachment: a }) => {
          const name = attachmentName(a);
          return (
            <Chip key={key} icon={a.kind === 'file' ? 'file' : undefined} onRemove={() => attachments.remove(key)} removeLabel={`Remove ${name}`} title={a.kind === 'file' ? a.path : name} className="max-w-[240px]">
              {a.kind === 'image' && <img src={imageSrc(a)} alt="" className="w-4 h-4 rounded-[3px] object-cover" />}
              <span className="truncate">{name}</span>
              <span className="font-mono text-[11px] text-ink-3">{formatSize(attachmentBytes(a))}</span>
            </Chip>
          );
        })}
        <button
          type="button"
          aria-expanded={adding}
          onClick={() => setAdding((a) => !a)}
          className="h-[26px] px-2.5 rounded-[13px] border border-dashed border-line-hover bg-transparent text-ink-2 text-[12px] hover:text-ink hover:border-ink-4"
        >
          + Artifact, file or URL
        </button>
        {attachments && <AttachFileButton state={attachments} variant="pill" />}
      </div>
      {attachments?.error && (
        <span className="text-[12px] text-bad" role="alert">
          {attachments.error}
        </span>
      )}
      {adding && <AddContext projectId={projectId} onAdd={add} onCancel={() => setAdding(false)} />}
    </div>
  );
}

function AddContext({ projectId, onAdd, onCancel }: { projectId: string; onAdd: (c: ContextChip) => void; onCancel: () => void }) {
  const id = useId();
  const [kind, setKind] = useState<Kind>('artifact');
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [artifactId, setArtifactId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void invokeOr('artifacts.list', projectId ? { projectId } : {}, []).then(
      (list) => {
        if (cancelled) return;
        setArtifacts(list);
        setArtifactId((cur) => cur || list[0]?.id || '');
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    setError(null);
    if (kind !== 'artifact') inputRef.current?.focus();
  }, [kind]);

  const submit = () => {
    if (kind === 'artifact') {
      const a = artifacts.find((x) => x.id === artifactId);
      if (!a) return setError('Pick an artifact.');
      return onAdd({ kind: 'artifact', id: a.id, title: a.title });
    }
    const v = text.trim();
    if (!v) return setError(kind === 'file' ? 'Type a path in the project.' : 'Type a URL.');
    if (kind === 'url') {
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
      } catch {
        return setError('That is not a valid http(s) URL.');
      }
      return onAdd({ kind: 'url', url: v });
    }
    if (/^([a-z]:)?[\\/]/i.test(v) || v.split(/[\\/]/).includes('..')) return setError('Use a path relative to the project, without "..".');
    return onAdd({ kind: 'file', path: v.replace(/\\/g, '/') });
  };

  return (
    <div
      className="flex flex-col gap-2.5 p-3 rounded-lg border border-line-2 bg-panel"
      role="group"
      aria-label="Add context"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && (e.target as HTMLElement).tagName !== 'BUTTON') {
          e.preventDefault();
          submit();
        }
      }}
    >
      <SegmentedControl
        label="Kind of context"
        variant="inset"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'artifact', label: 'Artifact' },
          { value: 'file', label: 'File' },
          { value: 'url', label: 'URL' },
        ]}
        className="self-start"
      />
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          {kind === 'artifact' ? 'Artifact' : kind === 'file' ? 'File path in the project' : 'URL'}
        </label>
        {kind === 'artifact' ? (
          <select id={id} value={artifactId} onChange={(e) => setArtifactId(e.target.value)} className={fieldClass(34, 'chrome', Boolean(error), 'flex-1')} disabled={!artifacts.length}>
            {!artifacts.length && <option value="">No artifacts in this project</option>}
            {artifacts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title} ({a.kind})
              </option>
            ))}
          </select>
        ) : (
          <input
            id={id}
            ref={inputRef}
            type={kind === 'url' ? 'url' : 'text'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={kind === 'file' ? 'src/shell/StatusBar.tsx' : 'https://…'}
            aria-invalid={error ? true : undefined}
            className={fieldClass(34, 'chrome', Boolean(error), kind === 'file' ? 'flex-1 font-mono text-[12.5px]!' : 'flex-1')}
          />
        )}
        <Button size={32} variant="primary" onClick={submit}>
          Add
        </Button>
        <Button size={32} variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <span className="text-[12px] text-bad" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
