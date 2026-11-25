import { useEffect, useState } from 'react';
import type { ArtifactKind, ArtifactMeta } from '@oide/protocol';
import { Icon, LinkButton } from '@oide/ui';
import { invokeOr, oide } from '../../../lib/bridge';
import { projectName, useProjects } from '../../../stores/projects';
import { navigate } from '../../../stores/router';
import { useScope } from '../../../stores/scope';
import { ResizableAside } from '../../../components/ResizableAside';
import { PANELS } from '../../../lib/panels';

const KIND_LABEL: Record<ArtifactKind, string> = { design: 'Design', doc: 'Doc', whiteboard: 'Whiteboard' };

/** Right aside on the Wall: the three most recent artifacts in scope, and the Marketplace teaser. */
export function ArtifactsAside() {
  const scope = useScope((s) => s.scope);
  const projects = useProjects((s) => s.list);
  const [items, setItems] = useState<ArtifactMeta[]>([]);
  const [usedBy, setUsedBy] = useState<Record<string, { agents: number; writing: boolean }>>({});

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      invokeOr('artifacts.list', scope === 'all' ? {} : { projectId: scope }, []).then(
        (list) => {
          if (cancelled) return;
          // Only artifacts of open projects (and global ones): a closed project's artifacts are
          // not reachable from here.
          const open = new Set(useProjects.getState().list.map((p) => p.id));
          const top = [...list]
            .filter((a) => !a.projectId || open.has(a.projectId))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 3);
          setItems(top);
          if (!top.length) {
            setUsedBy({});
            return;
          }
          void invokeOr('artifacts.uses', { ids: top.map((a) => a.id) }, {}).then(
            (uses) => {
              if (cancelled) return;
              const recent = Date.now() - 5 * 60_000;
              setUsedBy(
                Object.fromEntries(
                  Object.entries(uses).map(([id, list]) => [
                    id,
                    { agents: new Set(list.map((u) => u.agentId)).size, writing: list.some((u) => (u.op === 'write' || u.op === 'create') && u.ts > recent) },
                  ]),
                ),
              );
            },
            () => {},
          );
        },
        () => {},
      );
    void load();
    const off = oide.on('artifacts.changed', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [scope, projects]);

  return (
    <ResizableAside panel={PANELS.wallArtifacts} handleClassName="hidden min-[1280px]:block" aria-label="Artifacts" className="hidden min-[1280px]:flex flex-col gap-3 px-4 py-[18px] bg-panel border-l border-line box-border overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-[13px] font-semibold">Artifacts</h2>
        <a
          href="#artifacts"
          className="h-7 px-2 flex items-center text-[12px] no-underline"
          onClick={(e) => {
            e.preventDefault();
            navigate('artifacts', {});
          }}
        >
          See all
        </a>
      </div>

      <ul className="m-0 p-0 list-none flex flex-col gap-2.5">
        {items.length === 0 && <li className="text-[12px] text-ink-3 leading-normal">No artifacts yet. Designs, docs and whiteboards your agents use show up here.</li>}
        {items.map((a) => (
          <li key={a.id}>
            <a
              href={`#artifacts/${a.id}`}
              onClick={(e) => {
                e.preventDefault();
                navigate('artifacts', { artifactId: a.id });
              }}
              className="block border border-line-2 rounded-lg overflow-hidden bg-card no-underline text-ink hover:border-line-hover hover:text-ink"
            >
              <Thumb kind={a.kind} />
              <span className="px-2.5 py-2 flex flex-col gap-0.5">
                <span className="font-semibold truncate">{a.title}</span>
                <span className="text-[12px] text-ink-3 truncate">
                  {KIND_LABEL[a.kind]}
                  {a.projectId ? ` · ${projectName(projects, a.projectId)}` : ''}
                  {usedBy[a.id]?.writing ? ' · being written now' : usedBy[a.id]?.agents ? ` · used by ${usedBy[a.id]!.agents} ${usedBy[a.id]!.agents === 1 ? 'agent' : 'agents'}` : ''}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>

      <div className="flex-1" />
      <div className="border border-line-2 rounded-lg p-3 bg-card flex flex-col gap-2">
        <div className="flex items-center gap-2 font-semibold">
          <Icon name="marketplace" className="text-accent" />
          Marketplace
        </div>
        <span className="text-[12px] text-ink-3 leading-normal">Extensions that give agents new tools: database inspectors, browser preview, deploy targets.</span>
        <LinkButton
          href="#marketplace"
          className="h-[30px]! w-full"
          onClick={(e) => {
            e.preventDefault();
            navigate('marketplace', {});
          }}
        >
          Browse extensions
        </LinkButton>
      </div>
    </ResizableAside>
  );
}

/** Abstract previews drawn on the canvas for each artifact kind. */
function Thumb({ kind }: { kind: ArtifactKind }) {
  if (kind === 'design')
    return (
      <span aria-hidden="true" className="h-[72px] bg-raised p-2.5 box-border flex gap-1.5">
        <span className="w-[30%] bg-line-2 rounded-[4px]" />
        <span className="flex-1 grid grid-cols-3 gap-1">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="bg-line-5 rounded-xs" />
          ))}
        </span>
      </span>
    );
  if (kind === 'doc')
    return (
      <span aria-hidden="true" className="h-[72px] bg-raised p-3 box-border flex flex-col gap-1.5">
        <span className="w-[60%] h-2 bg-line-3 rounded-xs" />
        <span className="w-[90%] h-[5px] bg-line-5 rounded-xs" />
        <span className="w-[85%] h-[5px] bg-line-5 rounded-xs" />
        <span className="w-[70%] h-[5px] bg-line-5 rounded-xs" />
      </span>
    );
  return (
    <span aria-hidden="true" className="h-[72px] bg-raised relative block">
      <span className="absolute left-3.5 top-3.5 w-[46px] h-[26px] border-[1.5px] border-review rounded-sm" />
      <span className="absolute left-[60px] top-[27px] w-10 h-[1.5px] bg-ink-4" />
      <span className="absolute left-[100px] top-3.5 w-[46px] h-[26px] border-[1.5px] border-ok rounded-[13px]" />
      <span className="absolute left-[146px] top-[27px] w-10 h-[1.5px] bg-ink-4" />
      <span className="absolute left-[186px] top-3.5 w-[46px] h-[26px] border-[1.5px] border-warn rounded-sm" />
    </span>
  );
}
