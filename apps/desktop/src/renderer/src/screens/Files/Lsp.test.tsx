// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LspDiagnostic } from '@oide/protocol';
import { useScope } from '../../stores/scope';
import { setupMockApp } from '../SourceControl/testing';
import { useChanges } from './changesStore';
import { useFiles } from './filesStore';
import FilesScreen from './index';
import { Toasts } from '../../components/frame/Toasts';
import { useTerminals } from '../../stores/terminals';
import { useUi } from '../../stores/ui';
import { promptInstall, resetInstallPrompts } from './lspInstall';
import { LspStatusControl } from './LspStatus';
import { docKey, problemsOf, problemSummary, useLsp } from './lspStore';
import { useSearch } from './searchStore';
import type { EditorPaneProps } from './EditorPane';

vi.mock('./EditorPane', () => ({
  default: ({ active, reveal }: EditorPaneProps) => (
    <div data-testid="editor">
      {active.path}
      {reveal ? ` at ${reveal.line}:${reveal.column ?? 0}` : ''}
    </div>
  ),
}));

const ROOT = '/Users/you/code/billing-api';
const diag = (line: number, severity: 1 | 2 | 3 | 4, message: string): LspDiagnostic => ({ range: { start: { line, character: 2 }, end: { line, character: 6 } }, severity, message });

beforeEach(() => {
  useFiles.setState({ openProjects: {}, checkout: {}, expanded: {}, nodes: {}, loading: {}, errors: {}, tabs: [], active: undefined, dirty: {}, mdView: {}, revealed: {}, pending: undefined, revealTarget: undefined, edit: undefined, clipboard: undefined });
  useSearch.setState({ open: false });
  useChanges.setState({ byRoot: {} });
  useLsp.setState({ problems: {}, status: {} });
});
afterEach(() => cleanup());

describe('lspStore', () => {
  it('counts errors and warnings per file and forgets files whose list is empty', () => {
    const s = useLsp.getState();
    s.setProblems(ROOT, 'src/a.ts', [diag(0, 1, 'x'), diag(1, 1, 'y'), diag(2, 2, 'z'), diag(3, 4, 'hint')]);
    expect(useLsp.getState().problems[docKey(ROOT, 'src/a.ts')]).toMatchObject({ errors: 2, warnings: 1 });
    s.setProblems(ROOT, 'src/a.ts', []);
    expect(useLsp.getState().problems[docKey(ROOT, 'src/a.ts')]).toBeUndefined();
  });

  it('tints every folder above a file with its worst level, per checkout', () => {
    const s = useLsp.getState();
    s.setProblems(ROOT, 'src/webhooks/retry.ts', [diag(0, 2, 'unused')]);
    s.setProblems(ROOT, 'src/invoices/pdf.ts', [diag(0, 1, 'type error')]);
    s.setProblems('/elsewhere', 'src/x.ts', [diag(0, 1, 'other checkout')]);
    const p = problemsOf(useLsp.getState().problems, ROOT);
    expect([...p.files.keys()].sort()).toEqual(['src/invoices/pdf.ts', 'src/webhooks/retry.ts']);
    expect(p.dirs.get('src')).toBe('error');
    expect(p.dirs.get('src/webhooks')).toBe('warning');
    expect(p.dirs.get('src/invoices')).toBe('error');
    // Hints and infos alone do not decorate.
    s.setProblems(ROOT, 'README.md', [diag(0, 3, 'info')]);
    expect(problemsOf(useLsp.getState().problems, ROOT).files.has('README.md')).toBe(false);
    expect(problemSummary({ errors: 1, warnings: 2 })).toBe('1 error, 2 warnings');
  });

  it('a server state change reaches every open document it serves in that checkout', () => {
    const s = useLsp.getState();
    s.setStatus(ROOT, 'a.ts', { state: 'starting', language: 'typescript' });
    s.setStatus(ROOT, 'b.py', { state: 'starting', language: 'python' });
    s.setStatus('/other', 'c.ts', { state: 'starting', language: 'typescript' });
    s.applyState(ROOT, 'typescript', { state: 'running', language: 'typescript', server: 'TS' });
    const st = useLsp.getState().status;
    expect(st[docKey(ROOT, 'a.ts')]?.state).toBe('running');
    expect(st[docKey(ROOT, 'b.py')]?.state).toBe('starting');
    expect(st[docKey('/other', 'c.ts')]?.state).toBe('starting');
  });
});

describe('Files tree problem decorations', () => {
  async function setup() {
    await setupMockApp({ screen: 'files', params: {} });
    useScope.setState({ scope: 'billing-api' });
    render(<FilesScreen />);
    return screen.findByRole('tree', { name: 'billing-api (main)' });
  }

  it('files with errors are red with a count; folders above them say they contain problems', async () => {
    useLsp.getState().setProblems(ROOT, 'package.json', [diag(0, 1, 'Expected comma'), diag(1, 1, 'Bad value'), diag(2, 2, 'Deprecated')]);
    useLsp.getState().setProblems(ROOT, 'test/handler.test.ts', [diag(0, 2, 'Unused import')]);
    const tree = await setup();
    const pkg = await within(tree).findByRole('treeitem', { name: /^package\.json, 2 errors, 1 warning/ });
    expect(within(pkg).getByTestId('problem-count').textContent).toBe('3');
    expect(within(pkg).getByText('package.json').className).toContain('text-bad');
    expect(pkg.getAttribute('title')).toContain('2 errors, 1 warning');
    const test = await within(tree).findByRole('treeitem', { name: /^test, contains warnings/ });
    expect(within(test).getByText('test').className).toContain('text-warn');
  });

  it('the Problems list shows the open file’s diagnostics, errors first, and jumps to one', async () => {
    const tree = await setup();
    fireEvent.click(await within(tree).findByRole('treeitem', { name: /^README\.md/ }));
    await screen.findByTestId('editor');
    useLsp.getState().setProblems(ROOT, 'README.md', [diag(7, 2, 'Long line'), diag(3, 1, 'Broken link')]);
    const list = await screen.findByRole('region', { name: 'Problems' });
    const items = within(list).getAllByRole('button');
    expect(items.map((b) => b.textContent)).toEqual(['Error: Broken linkLn 4', 'Warning: Long lineLn 8']);
    fireEvent.click(items[1]!);
    await waitFor(() => expect(screen.getByTestId('editor').textContent).toBe('README.md at 8:2'));
  });
});

describe('LspStatusControl', () => {
  it('not installed: says so, and offers Install (a terminal runs the command) and Try again', async () => {
    const onRestart = vi.fn();
    const onInstall = vi.fn();
    render(
      <LspStatusControl
        status={{ state: 'not-installed', language: 'typescript', server: 'TypeScript language server', install: 'npm install -g typescript-language-server typescript' }}
        onNextProblem={() => {}}
        onRestart={onRestart}
        onInstall={onInstall}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Language server: TypeScript language server not installed' });
    expect(btn.getAttribute('title')).toContain('npm install -g typescript-language-server typescript');
    fireEvent.click(btn);
    const menu = await screen.findByRole('menu', { name: 'Language server' });
    expect(within(menu).queryByRole('menuitem', { name: /Copy install command/ })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Install/ }));
    expect(onInstall).toHaveBeenCalled();
    fireEvent.click(btn);
    fireEvent.click(within(await screen.findByRole('menu', { name: 'Language server' })).getByRole('menuitem', { name: /Try again/ }));
    expect(onRestart).toHaveBeenCalled();
  });

  it('running: the server name and the problem counts, which go to the next problem', () => {
    const onNext = vi.fn();
    render(<LspStatusControl status={{ state: 'running', server: 'Pyright' }} problems={{ errors: 2, warnings: 0, list: [] }} onNextProblem={onNext} onRestart={() => {}} onInstall={() => {}} />);
    expect(screen.getByRole('button', { name: 'Language server: Pyright' }).getAttribute('data-lsp-state')).toBe('running');
    fireEvent.click(screen.getByRole('button', { name: '2 errors. Go to the next problem' }));
    expect(onNext).toHaveBeenCalled();
  });

  it('untrusted: off, no menu; nothing at all without a server or problems', () => {
    const { container, rerender } = render(<LspStatusControl status={{ state: 'untrusted', server: 'gopls' }} onNextProblem={() => {}} onRestart={() => {}} onInstall={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Language server: Language server off' });
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.getAttribute('title')).toMatch(/not trusted/);
    rerender(<LspStatusControl onNextProblem={() => {}} onRestart={() => {}} onInstall={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('install prompt for a missing language server', () => {
  const missing = { state: 'not-installed' as const, language: 'python', server: 'Pyright', install: 'npm install -g pyright' };
  beforeEach(() => {
    resetInstallPrompts();
    localStorage.clear();
    useUi.setState({ toasts: [] });
    useTerminals.setState({ sessions: {}, groups: {} });
  });

  it('asks once; Install opens a Files terminal that installs the document’s server', async () => {
    render(<Toasts />);
    promptInstall(ROOT, 'src/app.py', missing);
    promptInstall(ROOT, 'src/other.py', missing); // same language: asked already
    const t = await screen.findByRole('status');
    expect(t.textContent).toContain('Pyright is not installed. Install it now?');
    expect(t.textContent).toContain('npm install -g pyright');
    expect(useUi.getState().toasts).toHaveLength(1);
    fireEvent.click(within(t).getByRole('button', { name: 'Install' }));
    const sessions = Object.values(useTerminals.getState().sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ group: 'files', kind: 'install', title: 'Install Pyright', cwd: ROOT, install: { root: ROOT, path: 'src/app.py' } });
    expect(useTerminals.getState().groups.files?.open).toBe(true);
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('No: never asked again for that language, even in a new run', async () => {
    render(<Toasts />);
    promptInstall(ROOT, 'src/app.py', missing);
    fireEvent.click(within(await screen.findByRole('status')).getByRole('button', { name: 'No' }));
    expect(useUi.getState().toasts).toEqual([]);
    expect(useTerminals.getState().sessions).toEqual({});
    resetInstallPrompts();
    promptInstall(ROOT, 'src/app.py', missing);
    expect(useUi.getState().toasts).toEqual([]);
    // Another language still asks.
    promptInstall(ROOT, 'src/main.go', { state: 'not-installed', language: 'go', server: 'gopls', install: 'go install golang.org/x/tools/gopls@latest' });
    expect(useUi.getState().toasts).toHaveLength(1);
  });

  it('no prompt without an install command, or when the server is not missing', () => {
    promptInstall(ROOT, 'a.rs', { state: 'not-installed', language: 'rust', server: 'rust-analyzer' });
    promptInstall(ROOT, 'a.py', { ...missing, state: 'running' });
    expect(useUi.getState().toasts).toEqual([]);
  });
});
