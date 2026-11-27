import { relative } from 'node:path';
import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { assertInside } from '../security/paths.js';
import { toHighlights, toHover, toLocations, toSignatureHelp, toSymbols, toTextEdits } from '../services/lsp/convert.js';
import type { Services } from '../services/index.js';

const toPosix = (p: string) => p.split('\\').join('/');

/**
 * lsp.* (ADR 0019): the Files editor's open documents and the language features it asks for.
 * Roots are project or agent-worktree checkouts only (never artifact folders); the document path
 * goes through the path guard and comes back normalised, so a session never sees `..` or `.git`.
 */
export function registerLspHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  const doc = (root: string, path: string) => {
    const r = ctx.roots.assertAllowed(root, ['project', 'worktree']);
    const abs = assertInside(r, path);
    const rel = toPosix(relative(r, abs));
    if (!rel || rel.startsWith('..')) throw new IpcError('Not a file of this checkout', 'forbidden_path');
    if (rel.split('/').includes('.git')) throw new IpcError('The .git folder is not available here', 'forbidden_path');
    return { root: r, path: rel };
  };
  const lsp = s.lsp;

  router.register('lsp.open', async ({ root, path, version, text }) => {
    const d = doc(root, path);
    return lsp.open(d.root, d.path, version, text);
  });
  router.register('lsp.change', ({ root, path, version, text }) => {
    const d = doc(root, path);
    lsp.change(d.root, d.path, version, text);
    return { ok: true as const };
  });
  router.register('lsp.close', ({ root, path }) => {
    const d = doc(root, path);
    lsp.close(d.root, d.path);
    return { ok: true as const };
  });
  router.register('lsp.status', ({ root, path }) => {
    const d = doc(root, path);
    return lsp.status(d.root, d.path);
  });
  router.register('lsp.restart', ({ root, path }) => {
    const d = doc(root, path);
    return lsp.restart(d.root, d.path);
  });

  router.register('lsp.install', async ({ root, path, cols, rows }) => {
    const d = doc(root, path);
    const install = lsp.installCommand(d.root, d.path);
    if (!install) throw new IpcError('This language server has no install command, or is installed already.', 'not_found');
    const { terminalId } = await s.terminals.create({ cwd: d.root, cols, rows, input: `${install.command}` });
    lsp.watchInstall(d.root, d.path);
    return { terminalId, ...install };
  });

  router.register('lsp.hover', ({ root, path, position }) => {
    const d = doc(root, path);
    return lsp.request(d.root, d.path, 'hoverProvider', 'textDocument/hover', () => ({ position }), toHover, null);
  });
  router.register('lsp.completion', ({ root, path, position, triggerCharacter }) => {
    const d = doc(root, path);
    return lsp.completion(d.root, d.path, position, triggerCharacter);
  });
  router.register('lsp.resolveCompletion', ({ root, path, resultId, index }) => {
    const d = doc(root, path);
    return lsp.resolveCompletion(d.root, d.path, resultId, index);
  });
  router.register('lsp.signatureHelp', ({ root, path, position, triggerCharacter }) => {
    const d = doc(root, path);
    const context = triggerCharacter ? { triggerKind: 2, triggerCharacter, isRetrigger: false } : { triggerKind: 1, isRetrigger: false };
    return lsp.request(d.root, d.path, 'signatureHelpProvider', 'textDocument/signatureHelp', () => ({ position, context }), toSignatureHelp, null);
  });
  const locations = (command: 'lsp.definition' | 'lsp.typeDefinition' | 'lsp.implementation', capability: string, method: string) =>
    router.register(command, ({ root, path, position }) => {
      const d = doc(root, path);
      return lsp.request(d.root, d.path, capability, method, () => ({ position }), (raw, sess) => toLocations(sess.root, raw), []);
    });
  locations('lsp.definition', 'definitionProvider', 'textDocument/definition');
  locations('lsp.typeDefinition', 'typeDefinitionProvider', 'textDocument/typeDefinition');
  locations('lsp.implementation', 'implementationProvider', 'textDocument/implementation');
  router.register('lsp.references', ({ root, path, position, includeDeclaration }) => {
    const d = doc(root, path);
    return lsp.request(d.root, d.path, 'referencesProvider', 'textDocument/references', () => ({ position, context: { includeDeclaration } }), (raw, sess) => toLocations(sess.root, raw), []);
  });
  router.register('lsp.highlights', ({ root, path, position }) => {
    const d = doc(root, path);
    return lsp.request(d.root, d.path, 'documentHighlightProvider', 'textDocument/documentHighlight', () => ({ position }), toHighlights, []);
  });
  router.register('lsp.symbols', ({ root, path }) => {
    const d = doc(root, path);
    return lsp.request(d.root, d.path, 'documentSymbolProvider', 'textDocument/documentSymbol', () => ({}), (raw, sess) => toSymbols(raw, sess.uri), []);
  });
  router.register('lsp.format', ({ root, path, tabSize, insertSpaces }) => {
    const d = doc(root, path);
    return lsp.request(d.root, d.path, 'documentFormattingProvider', 'textDocument/formatting', () => ({ options: { tabSize, insertSpaces } }), (raw) => toTextEdits(raw), []);
  });
}
