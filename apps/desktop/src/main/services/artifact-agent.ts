import type { AgentSpecInput, AgentSummary, ArtifactMeta, MessageAttachment, ModelSlot, ModelStrategy, PermissionMode, TelemetryEventName, TelemetryEventProps } from '@oide/protocol';
import { IpcError } from '../ipc/router.js';

/**
 * The artifact agent (Artifacts › open view): an ordinary oIDE agent (the user's own `claude` CLI,
 * queued behind Max running, on the Wall, asking for permissions) bound to one artifact. It works in
 * an empty scratch folder (`workIn: 'artifact-folder'`), and its contract (agent-core
 * `artifactContract`) has it read and change only that artifact through oIDE's MCP artifact tools,
 * so every change it makes is a numbered version the open view shows, compares and restores.
 */

export interface ArtifactAgentDeps {
  metaOf(id: string): ArtifactMeta;
  /** Live agents (the Wall). */
  agents(): AgentSummary[];
  spawn(spec: AgentSpecInput): Promise<AgentSummary[]>;
  /** Projects that exist (the artifact's own project may have been removed). */
  hasProject(projectId: string): boolean;
  /** What Spawn would use for this project: the default permission mode and model strategy. */
  defaults(projectId: string): Promise<{ mode: PermissionMode; strategy: ModelStrategy }>;
  track?: <K extends TelemetryEventName>(name: K, props: TelemetryEventProps<K>) => void;
}

export interface StartArtifactAgentInput {
  id: string;
  projectId?: string;
  text: string;
  attachments?: MessageAttachment[];
  mode?: PermissionMode;
  model?: ModelSlot;
}

/** The agent's title on the Wall and in the panel. */
export function artifactAgentTitle(meta: Pick<ArtifactMeta, 'title'>): string {
  return `Edit ${meta.title}`.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** The live (not archived) agent of an artifact, newest first. */
export function liveArtifactAgent(agents: AgentSummary[], artifactId: string): AgentSummary | undefined {
  return agents.filter((a) => a.artifactId === artifactId && !a.archived).sort((a, b) => b.createdAt - a.createdAt)[0];
}

export class ArtifactAgentService {
  constructor(private readonly d: ArtifactAgentDeps) {}

  /**
   * Start the artifact's agent with the user's first direction (its first message, as typed). The
   * project gives it settings, permissions and the trust rules: the artifact's own, else `projectId`
   * (`needs_project` when neither). Refused with `busy` while the artifact already has a live agent.
   */
  async start(input: StartArtifactAgentInput): Promise<AgentSummary> {
    let meta: ArtifactMeta;
    try {
      meta = this.d.metaOf(input.id);
    } catch {
      throw new IpcError(`Unknown artifact ${input.id}`, 'not_found');
    }
    if (meta.retrieval?.status === 'retrieving') throw new IpcError(`${meta.title} is still being retrieved. Start its agent when the files are in.`, 'busy');
    const live = liveArtifactAgent(this.d.agents(), meta.id);
    if (live) throw new IpcError(`${live.title} already works on this artifact. Send it a message instead.`, 'busy');
    const own = meta.projectId && this.d.hasProject(meta.projectId) ? meta.projectId : undefined;
    const projectId = own ?? (input.projectId && this.d.hasProject(input.projectId) ? input.projectId : undefined);
    if (!projectId) throw new IpcError('Choose the project the artifact agent runs under.', 'needs_project');
    const defaults = await this.d.defaults(projectId);
    const mode = input.mode ?? defaults.mode;
    const strategy: ModelStrategy = input.model ? { kind: 'single', lead: input.model } : defaults.strategy;
    const [agent] = await this.d.spawn({
      projectId,
      title: artifactAgentTitle(meta),
      goal: input.text,
      workIn: 'artifact-folder',
      artifactId: meta.id,
      mode,
      strategy,
      context: [],
      techniques: [],
      extensions: [],
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    if (!agent) throw new IpcError('The artifact agent could not be started.', 'internal');
    this.d.track?.('artifact_agent_started', { kind: meta.kind, mode });
    return agent;
  }
}
