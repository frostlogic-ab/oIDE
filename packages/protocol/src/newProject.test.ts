import { describe, expect, it } from 'vitest';
import { CloneUrl, FolderName, cloneUrlProblem, folderNameProblem, normalizeCloneInput, repoNameFromUrl } from './newProject.js';
import { Commands } from './ipc.js';

describe('folderNameProblem', () => {
  it.each(['my-project', 'oide', 'a.b_c', 'Web App', 'repo.v2'])('accepts %s', (name) => {
    expect(folderNameProblem(name)).toBeUndefined();
    expect(FolderName.safeParse(name).success).toBe(true);
  });

  it.each([
    '',
    ' ',
    '.',
    '..',
    'a/b',
    'a\\b',
    'C:',
    'x*',
    'x?',
    'a"b',
    'a<b',
    'a|b',
    'trailing.',
    'trailing ',
    ' lead',
    '-rf',
    'CON',
    'nul.txt',
    'com1',
    'LPT9',
    'a\u0000b',
    'x'.repeat(256),
    // .git in any spelling git or the file system treats as it
    '.git',
    '.GIT',
    '.Git.',
    '.git ',
    'git~1',
    'GIT~1',
  ])('refuses %j', (name) => {
    expect(folderNameProblem(name)).toBeTruthy();
    expect(FolderName.safeParse(name).success).toBe(false);
  });
});

describe('cloneUrlProblem', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo',
    'http://git.local:8080/team/repo.git',
    'https://user@dev.azure.com/org/project/_git/repo',
    'git://example.org/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'ssh://git@host.example:2222/owner/repo.git',
    'git@github.com:owner/repo.git',
    'git@gitlab.com:group/sub/repo.git',
    'https://[::1]/repo.git',
  ])('accepts %s', (url) => {
    expect(cloneUrlProblem(url)).toBeUndefined();
    expect(CloneUrl.safeParse(url).success).toBe(true);
  });

  it.each([
    '',
    '-uhelp',
    '--upload-pack=touch /tmp/pwned',
    'ext::sh -c touch% /tmp/pwned',
    'ext::sh',
    'fd::7',
    'transport::anything',
    'file:///C:/repos/secret',
    'file:///home/me/repo',
    'file://server/share/repo',
    'C:\\repos\\x',
    'C:/repos/x',
    '/home/me/repo',
    '\\\\server\\share\\repo',
    '../other',
    'https://github.com/owner/repo with space',
    'https://github.com/a\nb',
    'ssh://-oProxyCommand=touch@host/repo',
    '-oProxyCommand=x@host:repo',
    'git@host:-upload-pack',
    'git@host:/abs/but/scp',
    'ftp://example.org/repo.git',
    'https://',
    'https://' + 'a'.repeat(2100),
  ])('refuses %j', (url) => {
    expect(cloneUrlProblem(url)).toBeTruthy();
    expect(CloneUrl.safeParse(url).success).toBe(false);
  });

  it('trims what it accepts', () => {
    expect(CloneUrl.parse('  https://github.com/o/r.git \n'.trim())).toBe('https://github.com/o/r.git');
  });
});

describe('normalizeCloneInput', () => {
  it('turns GitHub shorthand and page links into clone URLs', () => {
    expect(normalizeCloneInput('octo/repo')).toBe('https://github.com/octo/repo.git');
    expect(normalizeCloneInput(' octo/repo.git ')).toBe('https://github.com/octo/repo.git');
    expect(normalizeCloneInput('https://github.com/octo/repo')).toBe('https://github.com/octo/repo.git');
    expect(normalizeCloneInput('https://github.com/octo/repo/tree/main/src')).toBe('https://github.com/octo/repo.git');
    expect(normalizeCloneInput('https://github.com/octo/repo.git')).toBe('https://github.com/octo/repo.git');
  });

  it('leaves everything else alone (trimmed)', () => {
    expect(normalizeCloneInput(' git@github.com:octo/repo.git ')).toBe('git@github.com:octo/repo.git');
    expect(normalizeCloneInput('https://gitlab.com/g/r.git')).toBe('https://gitlab.com/g/r.git');
    expect(normalizeCloneInput('ext::sh')).toBe('ext::sh');
    expect(normalizeCloneInput('../x')).toBe('../x');
  });
});

describe('repoNameFromUrl', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'repo'],
    ['https://github.com/owner/repo/', 'repo'],
    ['git@github.com:owner/my-app.git', 'my-app'],
    ['ssh://git@host:22/a/b/c.git', 'c'],
    ['https://dev.azure.com/org/p/_git/Repo?x=1', 'Repo'],
    ['https://host/owner/.git', ''],
    ['', ''],
  ])('%s → %j', (url, name) => {
    expect(repoNameFromUrl(url)).toBe(name);
  });
});

describe('IPC contract', () => {
  it('projects.clone validates the URL and the folder name', () => {
    const input = Commands['projects.clone'].input;
    expect(input.safeParse({ url: 'https://github.com/o/r.git', parent: 'C:\\code', name: 'r' }).success).toBe(true);
    expect(input.parse({ url: 'https://github.com/o/r.git', parent: '/code', name: 'r' }).source).toBe('url');
    expect(input.safeParse({ url: 'ext::sh -c x', parent: '/code', name: 'r' }).success).toBe(false);
    expect(input.safeParse({ url: 'https://github.com/o/r.git', parent: '/code', name: '../r' }).success).toBe(false);
    expect(input.safeParse({ url: 'https://github.com/o/r.git', parent: '/code', name: '.git' }).success).toBe(false);
  });

  it('projects.create defaults to a README', () => {
    expect(Commands['projects.create'].input.parse({ parent: '/code', name: 'x' }).readme).toBe(true);
    expect(Commands['projects.initFolder'].input.parse({ path: '/code/x' }).commitFiles).toBe(true);
  });
});
