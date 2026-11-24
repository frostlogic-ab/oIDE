import type { CustomServer, InstalledExtension } from '@oide/protocol';
import type { SecretStore } from './interfaces.js';
import type { LoadedExtension } from './manifest.js';

/**
 * Builds the MCP part of an agent's launch: `mcpServers` for `--mcp-config`, plus the
 * `--allowedTools` / `--disallowedTools` lists and the env that fills `${VAR}` placeholders.
 *
 * Rules (build brief, Risk labels): `read` tools of enabled extensions and custom servers are
 * pre-allowed; `ask` tools are never pre-allowed; turned-off tools are disallowed.
 */

export type McpServerJson =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface AgentMcpConfig {
  mcpServers: Record<string, McpServerJson>;
  allowedTools: string[];
  disallowedTools: string[];
  /** Secret values for `${VAR}` placeholders; add to the agent's env at spawn, never write to disk. */
  env: Record<string, string>;
  warnings: string[];
}

export interface ProxyRoute {
  /** `http://127.0.0.1:<port>/mcp/<server>` */
  urlFor(server: string): string;
  headerName: string;
  /** This agent's secret (McpProxy.issueAgentSecret). */
  agentSecret: string;
}

export interface BuildMcpConfigInput {
  projectId: string;
  /** Extensions already filtered to the ones enabled for this project. */
  extensions: Array<{ record: InstalledExtension; loaded: LoadedExtension }>;
  /** All custom servers; filtered here by project. */
  customServers: CustomServer[];
  /** Untrusted projects ignore project MCP servers (`.mcp.json`). Default true. */
  projectTrusted?: boolean;
  /** Needed for remote servers with OAuth or header tokens. */
  proxy?: ProxyRoute;
  /** Secret env values per custom server id, keyed by env var name. */
  secrets?: Record<string, Record<string, string>>;
  /** Replaces a manifest's `node` command, e.g. a bundled Node path. Default `node`. */
  nodeCommand?: string;
  /**
   * Also list `.mcp.json` servers in `--mcp-config`. Default false: the CLI reads `.mcp.json`
   * natively, so oIDE only adds their allow/deny lists and env.
   */
  includeProjectMcpJson?: boolean;
}

/** Server names oIDE reserves for itself. */
const RESERVED = new Set(['oide']);

/**
 * The name Claude Code gives an MCP tool: `mcp__<server>__<tool>`, with characters outside
 * `[a-zA-Z0-9_-]` replaced by `_` (verified on CLI 2.1.325: `db.schema` → `db_schema`; see docs/wiki/pages/cli-integration.md).
 */
export function mcpToolName(server: string, tool: string): string {
  const norm = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${norm(server)}__${norm(tool)}`;
}

/** Env var name oIDE uses for a "My settings" server's secret: `OIDE_MCP_<SERVER>_<KEY>`. */
export function secretEnvName(server: string, key: string): string {
  return `OIDE_MCP_${server.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/**
 * The risk label oIDE uses for an extension tool. Folder and git extensions are unreviewed: their
 * own `read` labels are never believed, so every tool asks first (SEC-15). Marketplace labels are
 * cross-checked against the index at install; built-ins ship with oIDE.
 */
export function effectiveToolRisk(record: Pick<InstalledExtension, 'source'>, declared: 'read' | 'ask'): 'read' | 'ask' {
  return record.source === 'folder' || record.source === 'git' ? 'ask' : declared;
}

export function customServerAppliesTo(server: CustomServer, projectId: string): boolean {
  return server.allProjects || server.projects.includes(projectId);
}

export function buildMcpConfig(input: BuildMcpConfigInput): AgentMcpConfig {
  const out: AgentMcpConfig = { mcpServers: {}, allowedTools: [], disallowedTools: [], env: {}, warnings: [] };
  const taken = new Set<string>();
  const claim = (name: string, owner: string): boolean => {
    if (RESERVED.has(name)) {
      out.warnings.push(`${owner}: MCP server name "${name}" is reserved by oIDE; skipped`);
      return false;
    }
    if (taken.has(name)) {
      out.warnings.push(`${owner}: MCP server name "${name}" is already used; skipped`);
      return false;
    }
    taken.add(name);
    return true;
  };
  const allow = new Set<string>();
  const deny = new Set<string>();

  for (const { record, loaded } of input.extensions) {
    const off = new Set(record.disabledTools);
    for (const [name, s] of Object.entries(loaded.mcpServers)) {
      if (!claim(name, record.name)) continue;
      const command = s.command === 'node' && input.nodeCommand ? input.nodeCommand : s.command;
      const json: McpServerJson = { type: 'stdio', command, args: s.args, cwd: s.cwd };
      if (Object.keys(s.env).length) json.env = { ...s.env };
      out.mcpServers[name] = json;
      for (const [tool, t] of Object.entries(s.tools)) {
        const full = mcpToolName(name, tool);
        if (off.has(full)) deny.add(full);
        else if (effectiveToolRisk(record, t.risk) === 'read') allow.add(full);
      }
    }
  }

  const trusted = input.projectTrusted ?? true;
  for (const server of input.customServers) {
    if (!customServerAppliesTo(server, input.projectId)) continue;
    const inProjectFile = server.savedTo === 'project-mcp-json';
    if (inProjectFile && !trusted) continue;
    const secrets = input.secrets?.[server.id] ?? {};
    const listInConfig = !inProjectFile || input.includeProjectMcpJson;
    if (listInConfig && !claim(server.name, `custom server ${server.name}`)) continue;
    if (!listInConfig) taken.add(server.name);
    const t = server.transport;
    if (t.kind === 'stdio') {
      const env: Record<string, string> = {};
      for (const key of t.envKeys) {
        // .mcp.json uses the bare ${KEY}; generated configs use a namespaced var so servers never collide.
        const varName = inProjectFile ? key : secretEnvName(server.name, key);
        env[key] = `\${${varName}}`;
        const value = secrets[key];
        if (value !== undefined) out.env[varName] = value;
        else out.warnings.push(`custom server ${server.name}: no value stored for ${key}`);
      }
      if (listInConfig) {
        const json: McpServerJson = { type: 'stdio', command: t.command, args: t.args };
        if (Object.keys(env).length) json.env = env;
        out.mcpServers[server.name] = json;
      }
    } else if (listInConfig) {
      if (t.auth === 'none') {
        out.mcpServers[server.name] = { type: 'http', url: t.url };
      } else if (input.proxy) {
        // Tokens stay in oIDE: the agent talks to the loopback proxy with its own secret.
        out.mcpServers[server.name] = { type: 'http', url: input.proxy.urlFor(server.name), headers: { [input.proxy.headerName]: input.proxy.agentSecret } };
      } else {
        out.warnings.push(`custom server ${server.name}: needs the MCP proxy for its token; skipped`);
        taken.delete(server.name);
        continue;
      }
    }
    for (const tool of server.tools) {
      const full = mcpToolName(server.name, tool.name);
      if (!tool.enabled) deny.add(full);
      else if (tool.risk === 'read') allow.add(full);
    }
  }

  for (const d of deny) allow.delete(d);
  out.allowedTools = [...allow].sort();
  out.disallowedTools = [...deny].sort();
  return out;
}

/** Secret key in the SecretStore for a custom server's env var. */
export function customEnvSecretKey(serverId: string, key: string): string {
  return `custom/${serverId}/env/${key}`;
}

/** `buildMcpConfig` with custom servers' env secrets read from the keychain. */
export async function resolveAgentMcpConfig(input: Omit<BuildMcpConfigInput, 'secrets'> & { secretStore: SecretStore }): Promise<AgentMcpConfig> {
  const secrets: Record<string, Record<string, string>> = {};
  for (const s of input.customServers) {
    if (s.transport.kind !== 'stdio' || !customServerAppliesTo(s, input.projectId)) continue;
    const m: Record<string, string> = {};
    for (const key of s.transport.envKeys) {
      const v = await input.secretStore.get(customEnvSecretKey(s.id, key));
      if (v !== undefined) m[key] = v;
    }
    secrets[s.id] = m;
  }
  const { secretStore: _unused, ...rest } = input;
  return buildMcpConfig({ ...rest, secrets });
}

/** The file content for `<app-data>/agents/<id>/mcp.json` (no secret values, only placeholders). */
export function mcpConfigFile(cfg: AgentMcpConfig): string {
  return JSON.stringify({ mcpServers: cfg.mcpServers }, null, 2);
}
