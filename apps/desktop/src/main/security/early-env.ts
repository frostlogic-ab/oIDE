/**
 * Runs before any other main-process module (first import of src/main/index.ts).
 *
 * SEC-01: on Windows, libuv and CreateProcess look for a bare program name (`git`, `gh`, `node`) in
 * the current folder before PATH unless NoDefaultCurrentDirectoryInExePath is set. Main spawns git
 * with a repository as cwd, and child processes (agents, extension hosts, MCP servers) inherit this
 * env, so a repo that ships `git.exe` could otherwise run as the user. Well-known tools are also
 * resolved to absolute paths (`@oide/git` resolveTool, agent-core findOnPath); this covers the rest.
 */
if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';

export {};
