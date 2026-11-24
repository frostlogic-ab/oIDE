import { z } from 'zod';
import { Id } from './agent.js';

export const ToolRisk = z.enum(['read', 'ask']);
export type ToolRisk = z.infer<typeof ToolRisk>;

export const ManifestMcpServer = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  tools: z.record(z.string(), z.object({ risk: ToolRisk, description: z.string().optional() })).default({}),
});

export const ExtensionManifest = z.object({
  name: z.string().regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/),
  version: z.string(),
  description: z.string().optional(),
  repository: z.union([z.string(), z.object({ url: z.string() })]).optional(),
  oide: z.object({
    engine: z.string(),
    displayName: z.string(),
    publisher: z.string().optional(),
    categories: z.array(z.string()).default([]),
    activation: z.array(z.string()).default([]),
    main: z.string().optional(),
    mcpServers: z.record(z.string(), ManifestMcpServer).default({}),
    contributes: z
      .object({
        panels: z.array(z.object({ id: z.string(), title: z.string(), entry: z.string(), location: z.enum(['inspector', 'screen']).default('inspector') })).default([]),
        commands: z.array(z.object({ id: z.string(), title: z.string(), keybinding: z.string().optional() })).default([]),
        settings: z.record(z.string(), z.object({ type: z.enum(['string', 'number', 'boolean']), secret: z.boolean().default(false), description: z.string().optional(), default: z.unknown().optional() })).default({}),
        themes: z.array(z.object({ id: z.string(), label: z.string(), tokens: z.record(z.string(), z.string()) })).default([]),
        techniques: z.array(z.object({ id: z.string(), name: z.string(), text: z.string(), placement: z.enum(['first-message', 'system-prompt']) })).default([]),
        artifactTypes: z.array(z.object({ id: z.string(), label: z.string(), entry: z.string() })).default([]),
        languages: z.array(z.object({ id: z.string(), extensions: z.array(z.string()), command: z.string(), args: z.array(z.string()).default([]) })).default([]),
        deployTargets: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
      })
      .default({ panels: [], commands: [], settings: {}, themes: [], techniques: [], artifactTypes: [], languages: [], deployTargets: [] }),
    capabilities: z
      .object({ network: z.array(z.string()).default([]), spawn: z.boolean().default(false), fs: z.array(z.string()).default([]) })
      .default({ network: [], spawn: false, fs: [] }),
  }),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifest>;

/** One entry in the static marketplace index (oide-marketplace/index.json). */
export const MarketplaceEntry = z.object({
  name: z.string(),
  displayName: z.string(),
  publisher: z.string(),
  description: z.string(),
  categories: z.array(z.string()),
  repository: z.string().optional(),
  verified: z.boolean().default(false),
  /** `builtin` entries ship inside the app and are never downloaded; `npm` entries come from the registry. */
  source: z.enum(['npm', 'builtin']).default('npm'),
  downloads: z.number().int().nonnegative().default(0),
  rating: z.number().min(0).max(5).optional(),
  /** ISO date of the newest version, for the "Recently updated" sort. */
  updatedAt: z.string().optional(),
  versions: z.array(
    z.object({
      version: z.string(),
      tarball: z.string().url(),
      /** Subresource-integrity string from npm, e.g. "sha512-…". */
      integrity: z.string().regex(/^sha(256|384|512)-/),
      engine: z.string(),
      tools: z.array(z.object({ name: z.string(), risk: ToolRisk, description: z.string().optional() })).default([]),
      capabilities: z.object({ network: z.array(z.string()).default([]), spawn: z.boolean().default(false) }).optional(),
    }),
  ),
});
export type MarketplaceEntry = z.infer<typeof MarketplaceEntry>;

export const MarketplaceIndex = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  extensions: z.array(MarketplaceEntry),
});
export type MarketplaceIndex = z.infer<typeof MarketplaceIndex>;

/** Marketplace categories, in the order the Browse list shows them (Marketplace design). */
export const MARKETPLACE_CATEGORIES = [
  { id: 'agent-tools', label: 'Agent tools' },
  { id: 'review-testing', label: 'Review & testing' },
  { id: 'deploy-targets', label: 'Deploy targets' },
  { id: 'artifact-types', label: 'Artifact types' },
  { id: 'views-panels', label: 'Views & panels' },
  { id: 'themes', label: 'Themes' },
  { id: 'languages', label: 'Languages' },
] as const;

/** One update the Marketplace "Updates" count shows. `needsConsent` when it adds tools or capabilities. */
export const ExtensionUpdate = z.object({
  id: Id,
  name: z.string(),
  from: z.string(),
  to: z.string(),
  needsConsent: z.boolean(),
  addedTools: z.array(z.string()).default([]),
  addedCapabilities: z.array(z.string()).default([]),
});
export type ExtensionUpdate = z.infer<typeof ExtensionUpdate>;

export const InstalledExtension = z.object({
  id: Id,
  name: z.string(),
  version: z.string(),
  displayName: z.string(),
  source: z.enum(['builtin', 'marketplace', 'folder', 'git']),
  path: z.string(),
  enabledProjects: z.array(Id).default([]),
  enabledGlobally: z.boolean().default(false),
  /** Projects where a globally (or team-) enabled extension is turned off. */
  disabledProjects: z.array(Id).default([]),
  /** Tools the user turned off, as `mcp__<server>__<tool>` names. They join `--disallowedTools`. */
  disabledTools: z.array(z.string()).default([]),
  reviewed: z.boolean().default(false),
  devMode: z.boolean().default(false),
  manifest: ExtensionManifest,
});
export type InstalledExtension = z.infer<typeof InstalledExtension>;

/** Add custom: all four routes end in this record. */
export const CustomTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  risk: ToolRisk,
  enabled: z.boolean().default(true),
});
export const CustomServer = z.object({
  id: Id,
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  route: z.enum(['url', 'import', 'command', 'extension']),
  transport: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('http'), url: z.string().url(), auth: z.enum(['none', 'oauth', 'header']).default('none') }),
    z.object({ kind: z.literal('stdio'), command: z.string(), args: z.array(z.string()).default([]), envKeys: z.array(z.string()).default([]) }),
  ]),
  tools: z.array(CustomTool).default([]),
  projects: z.array(Id).default([]),
  allProjects: z.boolean().default(false),
  savedTo: z.enum(['my-settings', 'project-mcp-json']),
  reviewed: z.literal(false).default(false),
  serverInfo: z.string().optional(),
});
export type CustomServer = z.infer<typeof CustomServer>;
