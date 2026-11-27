import { z } from 'zod';

/**
 * Language servers for the Files editor (ADR 0019). Servers come from extensions
 * (`contributes.languages`) and run in main, one per (language, checkout). The renderer never
 * talks LSP itself: it sends the open document's text and asks for a fixed set of features
 * (`lsp.*` commands); main forwards them, maps every `file://` URI back to a checkout-relative
 * path (dropping anything outside the checkout) and answers with these shapes.
 *
 * Positions are 0-based lines and UTF-16 code-unit characters, as in LSP.
 */

/** Longest text a document may have to be sent to a language server (larger files open without one). */
export const LSP_MAX_TEXT = 4 * 1024 * 1024;

export const LspPosition = z.object({ line: z.number().int().min(0).max(10_000_000), character: z.number().int().min(0).max(10_000_000) });
export type LspPosition = z.infer<typeof LspPosition>;
export const LspRange = z.object({ start: LspPosition, end: LspPosition });
export type LspRange = z.infer<typeof LspRange>;

/** A document in a project or agent-worktree checkout: `root` is the checkout, `path` relative with `/`. */
export const LspDocument = z.object({ root: z.string().min(1).max(4096), path: z.string().min(1).max(1024) });
export type LspDocument = z.infer<typeof LspDocument>;
export const LspAt = LspDocument.extend({ position: LspPosition });
export type LspAt = z.infer<typeof LspAt>;

/**
 * Where a document stands with its language server:
 * - `none`: no extension that is on for this project has a server for this kind of file.
 * - `untrusted`: the project is not trusted, so no server runs (servers execute repository code).
 * - `not-installed`: the server's command is not on PATH (`install` says how to get it).
 * - `starting` / `running`: the server is starting or answers requests.
 * - `failed`: it crashed too often or would not initialise (`message` has the reason).
 */
export const LspState = z.enum(['none', 'untrusted', 'not-installed', 'starting', 'running', 'failed']);
export type LspState = z.infer<typeof LspState>;

export const LspStatus = z.object({
  state: LspState,
  /** The language id the server was registered for (`typescript`). */
  language: z.string().max(100).optional(),
  /** Human name of the server (`TypeScript language server`). */
  server: z.string().max(200).optional(),
  /** Display name of the extension that contributes it. */
  extension: z.string().max(200).optional(),
  /** Install hint for `not-installed` (`npm i -g typescript-language-server typescript`). */
  install: z.string().max(500).optional(),
  message: z.string().max(2000).optional(),
});
export type LspStatus = z.infer<typeof LspStatus>;

/** LSP DiagnosticSeverity: 1 error, 2 warning, 3 information, 4 hint. */
export const LspSeverity = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type LspSeverity = z.infer<typeof LspSeverity>;

export const LspDiagnostic = z.object({
  range: LspRange,
  severity: LspSeverity,
  message: z.string().max(4000),
  source: z.string().max(200).optional(),
  code: z.string().max(200).optional(),
  /** Marked unnecessary (faded) or deprecated (struck through) by the server. */
  tags: z.array(z.union([z.literal(1), z.literal(2)])).max(2).optional(),
});
export type LspDiagnostic = z.infer<typeof LspDiagnostic>;

/** At most this many diagnostics are kept per file. */
export const LSP_MAX_DIAGNOSTICS = 500;

export const LspHover = z.object({ contents: z.string().max(100_000), range: LspRange.optional() });
export type LspHover = z.infer<typeof LspHover>;

export const LspTextEdit = z.object({ range: LspRange, newText: z.string().max(LSP_MAX_TEXT) });
export type LspTextEdit = z.infer<typeof LspTextEdit>;

export const LspCompletionItem = z.object({
  /** Index in the result (pass it to `lsp.resolveCompletion`). */
  index: z.number().int().min(0),
  label: z.string().max(1000),
  /** LSP CompletionItemKind (1-25). */
  kind: z.number().int().min(1).max(25).optional(),
  detail: z.string().max(4000).optional(),
  /** Markdown. */
  documentation: z.string().max(50_000).optional(),
  insertText: z.string().max(100_000).optional(),
  /** The text is a snippet (`${1:name}`). */
  snippet: z.boolean().optional(),
  /** Replace this range (the server's text edit) instead of the word at the cursor. */
  range: LspRange.optional(),
  additionalTextEdits: z.array(LspTextEdit).max(100).optional(),
  sortText: z.string().max(1000).optional(),
  filterText: z.string().max(1000).optional(),
  preselect: z.boolean().optional(),
  deprecated: z.boolean().optional(),
  commitCharacters: z.array(z.string().max(4)).max(20).optional(),
});
export type LspCompletionItem = z.infer<typeof LspCompletionItem>;

/** At most this many completion items are returned. */
export const LSP_MAX_COMPLETIONS = 1000;

export const LspCompletionList = z.object({
  /** Identifies this result for `lsp.resolveCompletion` (main keeps the server's raw items). */
  resultId: z.number().int(),
  incomplete: z.boolean(),
  items: z.array(LspCompletionItem).max(LSP_MAX_COMPLETIONS),
});
export type LspCompletionList = z.infer<typeof LspCompletionList>;

export const LspSignatureHelp = z.object({
  signatures: z
    .array(
      z.object({
        label: z.string().max(4000),
        documentation: z.string().max(50_000).optional(),
        parameters: z
          .array(z.object({ label: z.union([z.string().max(1000), z.tuple([z.number().int(), z.number().int()])]), documentation: z.string().max(10_000).optional() }))
          .max(100)
          .default([]),
      }),
    )
    .max(50),
  activeSignature: z.number().int().min(0).default(0),
  activeParameter: z.number().int().min(0).default(0),
});
export type LspSignatureHelp = z.infer<typeof LspSignatureHelp>;

/** A place in a checkout (definitions, references). Locations outside the checkout are dropped. */
export const LspLocation = z.object({ root: z.string(), path: z.string(), range: LspRange });
export type LspLocation = z.infer<typeof LspLocation>;

/** At most this many locations are returned (references in a large repo). */
export const LSP_MAX_LOCATIONS = 500;

export const LspHighlight = z.object({ range: LspRange, kind: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() });
export type LspHighlight = z.infer<typeof LspHighlight>;

export interface LspSymbol {
  name: string;
  detail?: string | undefined;
  /** LSP SymbolKind (1-26). */
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspSymbol[] | undefined;
}
export const LspSymbol: z.ZodType<LspSymbol> = z.lazy(() =>
  z.object({
    name: z.string().max(1000),
    detail: z.string().max(1000).optional(),
    kind: z.number().int().min(1).max(26),
    range: LspRange,
    selectionRange: LspRange,
    children: z.array(LspSymbol).max(5000).optional(),
  }),
);

/** Text sent with `lsp.open` / `lsp.change`: the whole document (full sync), with the editor's version. */
export const LspSync = LspDocument.extend({ version: z.number().int().min(0), text: z.string().max(LSP_MAX_TEXT) });
export type LspSync = z.infer<typeof LspSync>;

export const LspFormatInput = LspDocument.extend({ tabSize: z.number().int().min(1).max(16).default(2), insertSpaces: z.boolean().default(true) });

export const LspDiagnosticsEvent = z.object({
  root: z.string(),
  path: z.string(),
  /** Document version the server computed them for, when it says. */
  version: z.number().int().optional(),
  diagnostics: z.array(LspDiagnostic).max(LSP_MAX_DIAGNOSTICS),
});
export type LspDiagnosticsEvent = z.infer<typeof LspDiagnosticsEvent>;

/** A server for (`root`, `language`) changed state; documents of that language follow it. */
export const LspStateEvent = LspStatus.extend({ root: z.string(), language: z.string().max(100) });
export type LspStateEvent = z.infer<typeof LspStateEvent>;
