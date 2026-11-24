# Security policy

oIDE runs coding agents that execute shell commands on your machine, so security reports matter.

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security Advisories)
on this repository rather than in a public issue. Include steps to reproduce and the affected version.

In scope: the Electron app (main, preload, renderer), IPC validation, the oIDE MCP server and its
loopback endpoints, the extension host, installer and marketplace index checks, worktree and file path
handling, and anything that could expose credentials or bypass the permission prompt.

oIDE never reads, stores or forwards Claude credentials. A report showing otherwise is critical.
See [docs/wiki/pages/security.md](docs/wiki/pages/security.md) for the security model.
