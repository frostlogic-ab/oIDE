/**
 * Allow-list for URLs oIDE opens in the system browser (shell.openExternal, links, window.open).
 * Only https. A host matches when it equals an entry or is a subdomain of it.
 * Services may add hosts at runtime (e.g. the git service adds the host of a project's remote so
 * "Open PR" works for self-hosted forges).
 */
const DEFAULT_HOSTS = [
  'github.com',
  'githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'claude.ai',
  'anthropic.com',
  'claude.com',
  'npmjs.com',
  'modelcontextprotocol.io',
  'oide.dev',
];

const extraHosts = new Set<string>();

export function allowExternalHost(host: string): void {
  extraHosts.add(host.toLowerCase());
}

export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  for (const allowed of [...DEFAULT_HOSTS, ...extraHosts]) {
    if (host === allowed || host.endsWith('.' + allowed)) return true;
  }
  return false;
}
