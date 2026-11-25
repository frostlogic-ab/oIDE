/**
 * Settings (docs/wiki/raw/design/Settings.dc.html). Section list on the left, one section on the
 * right. Every control saves on change through `settings.update` (deep-merge patch) or the
 * section's own IPC command; see docs/wiki/pages/screen-settings.md.
 */
import { useEffect, useMemo, useState } from 'react';
import type { FocusPreset, Technique } from '@oide/protocol';
import { Spinner, cn } from '@oide/ui';
import { invokeOr } from '../../lib/bridge';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useSettings } from '../../stores/settings';
import { AgentsSection } from './AgentsSection';
import { ClaudeCodeSection } from './ClaudeCodeSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { ModelsSection } from './ModelsSection';
import { KeysSection } from './KeysSection';
import { AppearanceSection, ArtifactsSection, PrivacySection, ProjectsSection } from './OtherSections';
import { PermissionsSection } from './PermissionsSection';
import { TechniquesSection } from './TechniquesSection';
import { UpdatesSection } from './UpdatesSection';
import { ExtensionSettingsSection } from '../../extensions/ExtensionSettingsSection';

export type SectionId = 'cli' | 'models' | 'agents' | 'tech' | 'perms' | 'projects' | 'artifacts' | 'ext' | 'keys' | 'look' | 'privacy' | 'updates' | 'diag';
export interface LoadError {
  projectId?: string;
  file: string;
  message: string;
}

/** Sections in design order, with the words their rows contain (for Search settings). */
export const SECTIONS: Array<{ id: SectionId; label: string; keywords: string }> = [
  { id: 'cli', label: 'Claude Code', keywords: 'cli path version account sign in plan default mode bypass permissions extra flags' },
  { id: 'models', label: 'Models', keywords: 'default focus presets cheap balanced quality effort opus sonnet haiku fable versions latest pinned your models custom local bedrock vertex api key endpoint test connection' },
  { id: 'agents', label: 'Agents', keywords: 'max running queue worktree location clean up context amber compact notifications fetch remotes' },
  { id: 'tech', label: 'Techniques', keywords: 'techniques prompt adversarial review docs tests quality gates system prompt first message' },
  { id: 'perms', label: 'Permissions', keywords: 'permissions edit files shell commands network allowed denied rules' },
  { id: 'projects', label: 'Projects', keywords: 'projects trust trusted .oide folder' },
  { id: 'artifacts', label: 'Artifacts & claude.ai', keywords: 'artifacts claude.ai import sync designs docs whiteboards' },
  { id: 'ext', label: 'Extensions', keywords: 'extensions extension settings secret token keychain browser preview default url marketplace index url' },
  { id: 'keys', label: 'Keyboard shortcuts', keywords: 'keyboard shortcuts keys bindings' },
  { id: 'look', label: 'Appearance', keywords: 'appearance accent colour color theme' },
  { id: 'privacy', label: 'Privacy', keywords: 'privacy telemetry analytics usage statistics crash error reports send share' },
  { id: 'updates', label: 'Updates', keywords: 'updates version upgrade channel stable beta check now release download install' },
  { id: 'diag', label: 'Diagnostics', keywords: 'diagnostics logs log folder git version gh node keychain database mcp port report troubleshooting' },
];

const isSection = (s: string | undefined): s is SectionId => SECTIONS.some((x) => x.id === s);

export default function SettingsScreen() {
  const route = useRouter((s) => s.route);
  const param = route.screen === 'settings' ? route.params.section : undefined;
  const section: SectionId = isSection(param) ? param : 'cli';
  const go = (id: SectionId) => useRouter.getState().replace('settings', { section: id });

  const settings = useSettings((s) => s.settings);
  const projects = useProjects((s) => s.list);
  const [query, setQuery] = useState('');
  const [builtIns, setBuiltIns] = useState<{ presets: FocusPreset[]; techniques: Technique[] } | null>(null);
  const [loadErrors, setLoadErrors] = useState<LoadError[]>([]);

  useEffect(() => {
    void invokeOr('settings.builtIns', undefined, null).then(setBuiltIns);
    void invokeOr('settings.loadErrors', {}, []).then(setLoadErrors);
  }, []);
  // Settings may not be loaded yet (or main has no settings service yet): try once more on mount.
  useEffect(() => {
    if (!settings) void useSettings.getState().load().catch(() => undefined);
  }, [settings]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="flex-1 min-w-0 flex min-h-0">
      <aside aria-label="Settings sections" className="w-[230px] shrink-0 flex flex-col gap-0.5 px-2.5 py-3.5 bg-panel border-r border-line box-border overflow-y-auto">
        <label htmlFor="sset" className="sr-only">
          Search settings
        </label>
        <input
          id="sset"
          type="search"
          placeholder="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && visible[0]) go(visible[0].id);
          }}
          className="h-[34px] px-2.5 mb-2.5 rounded-md border border-line-3 bg-card text-ink text-[13px] outline-none focus:border-accent placeholder:text-ink-3"
        />
        <nav aria-label="Settings" className="flex flex-col gap-0.5">
          {visible.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={s.id === section ? 'page' : undefined}
              onClick={() => go(s.id)}
              className={cn(
                'h-8 px-2.5 border-0 rounded-[7px] text-left text-[13px]',
                s.id === section ? 'bg-selected text-ink' : 'bg-transparent text-ink-2 hover:bg-raised',
              )}
            >
              {s.label}
            </button>
          ))}
          {visible.length === 0 && <span className="px-2.5 py-2 text-[12.5px] text-ink-3">No settings match "{query}".</span>}
        </nav>
        <div className="flex-1" />
        <span className="px-2.5 py-2 text-[11.5px] text-ink-3 leading-normal">
          Settings sync with a project's <span className="font-mono">.oide/</span> folder when set per project.
        </span>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto px-8 py-[22px] box-border">
        <div className="max-w-[760px] flex flex-col">
          {loadErrors.length > 0 && <LoadErrorsBanner errors={loadErrors} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />}
          {!settings ? (
            <div className="flex items-center gap-2 text-ink-3 text-[12.5px] py-10">
              <Spinner /> Loading settings…
            </div>
          ) : section === 'cli' ? (
            <ClaudeCodeSection settings={settings} goModels={() => go('models')} />
          ) : section === 'models' ? (
            <ModelsSection settings={settings} builtIns={builtIns?.presets ?? null} />
          ) : section === 'agents' ? (
            <AgentsSection settings={settings} />
          ) : section === 'tech' ? (
            <TechniquesSection projects={projects} builtIns={builtIns?.techniques ?? null} />
          ) : section === 'perms' ? (
            <PermissionsSection settings={settings} projects={projects} />
          ) : section === 'projects' ? (
            <ProjectsSection projects={projects} errors={loadErrors} />
          ) : section === 'artifacts' ? (
            <ArtifactsSection />
          ) : section === 'ext' ? (
            <ExtensionSettingsSection />
          ) : section === 'keys' ? (
            <KeysSection />
          ) : section === 'look' ? (
            <AppearanceSection settings={settings} />
          ) : section === 'updates' ? (
            <UpdatesSection settings={settings} />
          ) : section === 'diag' ? (
            <DiagnosticsSection />
          ) : (
            <PrivacySection settings={settings} />
          )}
        </div>
      </main>
    </div>
  );
}

function LoadErrorsBanner({ errors, projects }: { errors: LoadError[]; projects: Array<{ id: string; name: string }> }) {
  return (
    <div role="alert" className="mb-[18px] p-3 rounded-lg border border-warn-line bg-warn-bg text-[12.5px] flex flex-col gap-1.5">
      <span className="font-semibold text-warn">
        {errors.length === 1 ? 'A settings file could not be read' : `${errors.length} settings files could not be read`}
      </span>
      <ul className="list-none m-0 p-0 flex flex-col gap-1 text-ink-2">
        {errors.map((e) => (
          <li key={`${e.projectId ?? ''}:${e.file}`}>
            {e.projectId && <span className="text-ink-3">{projects.find((p) => p.id === e.projectId)?.name ?? e.projectId} · </span>}
            <span className="font-mono text-[12px]">{e.file}</span>: {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
