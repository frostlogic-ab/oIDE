// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GithubRepo, OideBridge, Project } from '@oide/protocol';
import { installFallbackBridge } from '../lib/bridge';
import { useNewProject } from '../stores/newProject';
import { useProjects } from '../stores/projects';
import { NewProjectDialog } from './NewProjectDialog';

/**
 * New project dialog: the three tabs (Open folder, Clone repository, New repository) against a fake
 * bridge. Nothing here touches git or the network; main's side is covered in main/projects tests.
 */

const PARENT = '/code';
const project = (name: string): Project => ({ id: name, name, path: `${PARENT}/${name}`, trusted: false, createdAt: 0 });
const NO_GH = { available: false, repos: [], reason: 'gh is not signed in.' };

type Handler = (input: unknown) => unknown;
let handlers: Record<string, Handler>;
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  useNewProject.setState({ open: false, tab: 'open' });
  useProjects.setState({ list: [], loaded: false });
  handlers = { 'projects.githubRepos': () => NO_GH };
  invoke = vi.fn(async (command: string, input: unknown) => {
    const h = handlers[command];
    if (!h) throw new Error(`[not_implemented] ${command}`);
    return h(input);
  });
  installFallbackBridge({ invoke, on: () => () => {}, platform: 'win32' } as unknown as OideBridge);
});

afterEach(cleanup);

function show(tab: 'open' | 'clone' | 'create') {
  render(<NewProjectDialog />);
  act(() => useNewProject.getState().show(tab));
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const calls = (command: string) => invoke.mock.calls.filter(([c]) => c === command).map(([, input]) => input);

describe('New project dialog', () => {
  it('show("clone") opens the dialog on the Clone repository tab', async () => {
    show('clone');
    const tab = await screen.findByRole('tab', { name: 'Clone repository' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Open folder' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('tab', { name: 'New repository' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByLabelText('Repository')).toBeTruthy();
  });

  it('clone: owner/repo expands to a GitHub URL, fills the folder name, and a resolved clone closes the dialog', async () => {
    localStorage.setItem('oide.newProject.parent', PARENT);
    handlers['projects.clone'] = () => project('repo');
    show('clone');

    fireEvent.change(await screen.findByLabelText('Repository'), { target: { value: 'octo/repo' } });
    expect(screen.getByText('Clones https://github.com/octo/repo.git')).toBeTruthy();
    expect(field('Folder name').value).toBe('repo');
    expect(screen.getByText(PARENT)).toBeTruthy();

    fireEvent.click(button('Clone'));
    await waitFor(() => expect(useNewProject.getState().open).toBe(false));
    expect(calls('projects.clone')).toEqual([{ url: 'https://github.com/octo/repo.git', parent: PARENT, name: 'repo', source: 'url' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clone: a remote-helper URL shows an error after blur and keeps Clone disabled', async () => {
    localStorage.setItem('oide.newProject.parent', PARENT);
    show('clone');

    const repo = await screen.findByLabelText('Repository');
    fireEvent.change(repo, { target: { value: 'ext::sh -c touch' } });
    fireEvent.blur(repo);

    await waitFor(() => expect(screen.getByText(/cannot contain spaces|Remote helpers/)).toBeTruthy());
    expect(button('Clone').disabled).toBe(true);
    fireEvent.submit(repo.closest('form')!);
    expect(calls('projects.clone')).toEqual([]);
  });

  it('clone: picking one of your GitHub repositories fills the field and clones with source "github"', async () => {
    localStorage.setItem('oide.newProject.parent', PARENT);
    const repos: GithubRepo[] = [
      { nameWithOwner: 'octo/alpha', description: 'First', isPrivate: false, cloneUrl: 'https://github.com/octo/alpha.git' },
      { nameWithOwner: 'octo/beta', isPrivate: true, cloneUrl: 'git@github.com:octo/beta.git' },
    ];
    handlers['projects.githubRepos'] = () => ({ available: true, repos });
    handlers['projects.clone'] = () => project('beta');
    show('clone');

    fireEvent.click(await screen.findByRole('button', { name: /octo\/alpha/ }));
    expect(field('Repository').value).toBe('https://github.com/octo/alpha.git');
    fireEvent.click(screen.getByRole('button', { name: /octo\/beta/ }));
    expect(field('Repository').value).toBe('git@github.com:octo/beta.git');
    expect(field('Folder name').value).toBe('beta');

    fireEvent.click(button('Clone'));
    await waitFor(() => expect(calls('projects.clone')).toHaveLength(1));
    expect(calls('projects.clone')[0]).toEqual({ url: 'git@github.com:octo/beta.git', parent: PARENT, name: 'beta', source: 'github' });
    await waitFor(() => expect(useNewProject.getState().open).toBe(false));
  });

  it('open folder: a folder that is not a repository offers "Initialize git", which sends initFolder with commitFiles', async () => {
    const path = `${PARENT}/plain`;
    handlers['dialog.pickFolder'] = () => path;
    handlers['projects.open'] = () => {
      throw new Error(`[not_a_repo] ${path} is not a git repository`);
    };
    handlers['projects.initFolder'] = () => project('plain');
    show('open');

    fireEvent.click(await screen.findByRole('button', { name: 'Choose folder…' }));
    const init = await screen.findByRole('button', { name: 'Initialize git' });
    expect(calls('projects.open')).toEqual([{ path }]);
    expect(screen.getByText(/is not a git repository yet/)).toBeTruthy();

    fireEvent.click(init);
    await waitFor(() => expect(calls('projects.initFolder')).toEqual([{ path, commitFiles: true }]));
    await waitFor(() => expect(useNewProject.getState().open).toBe(false));
  });

  it('new repository: ".git" is refused; a valid name calls projects.create with a README', async () => {
    localStorage.setItem('oide.newProject.parent', PARENT);
    handlers['projects.create'] = () => project('fresh');
    show('create');

    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: '.git' } });
    fireEvent.blur(name);
    await waitFor(() => expect(screen.getByText('A project folder cannot be named .git.')).toBeTruthy());
    expect(button('Create repository').disabled).toBe(true);

    fireEvent.change(name, { target: { value: 'fresh' } });
    expect(button('Create repository').disabled).toBe(false);
    fireEvent.click(button('Create repository'));
    await waitFor(() => expect(calls('projects.create')).toEqual([{ parent: PARENT, name: 'fresh', readme: true }]));
    await waitFor(() => expect(useNewProject.getState().open).toBe(false));
  });

  it('clone: a location main refuses (forbidden_path) is asked for with the folder picker, then the clone is retried there', async () => {
    localStorage.setItem('oide.newProject.parent', PARENT);
    const picked = '/elsewhere';
    handlers['dialog.pickFolder'] = () => picked;
    handlers['projects.clone'] = (input) => {
      if ((input as { parent: string }).parent === PARENT) throw new Error(`[forbidden_path] ${PARENT} is not a location you chose`);
      return project('repo');
    };
    show('clone');

    fireEvent.change(await screen.findByLabelText('Repository'), { target: { value: 'octo/repo' } });
    fireEvent.click(button('Clone'));

    await waitFor(() => expect(calls('projects.clone')).toHaveLength(2));
    expect(calls('dialog.pickFolder')).toHaveLength(1);
    expect(calls('projects.clone')[1]).toEqual({ url: 'https://github.com/octo/repo.git', parent: picked, name: 'repo', source: 'url' });
    await waitFor(() => expect(useNewProject.getState().open).toBe(false));
    expect(localStorage.getItem('oide.newProject.parent')).toBe(picked);
  });
});
