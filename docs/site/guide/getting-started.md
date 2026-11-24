# Getting started

oIDE runs Claude Code agents for you, but it does not contain Claude Code. You bring your own
installed and signed-in `claude` CLI; oIDE starts it, one process per agent, and shows what every
agent is doing.

## Requirements

| What | Version | Notes |
| --- | --- | --- |
| [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) | 2.1.x tested | Installed and signed in. oIDE warns when your version is outside the tested range (2.1.0 to 2.99.99). |
| git | 2.38 or newer | Needed for worktrees and for `git merge-tree --write-tree` (conflict prediction). |
| GitHub CLI `gh` | optional | Only for opening and showing pull requests. Run `gh auth login` once. |
| OS | Windows 10/11, macOS 12+, Linux | x64 and arm64. |

## Install

oIDE is pre-1.0. Installers are built by CI from version tags and published on
[GitHub Releases](https://github.com/oide-dev/oide/releases). Until the first release is published,
[build from source](#build-from-source).

| OS | Download | Install |
| --- | --- | --- |
| Windows | `oIDE-<version>-win-x64.exe` (or `-arm64`), or the `.zip` | Per-user NSIS installer; you can choose the folder. |
| macOS | `oIDE-<version>-mac-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) | Drag oIDE to Applications. |
| Linux | `.AppImage`, `.deb` or `.rpm` for x64 or arm64 | See below. |

### Unsigned builds

Until the project has code-signing accounts, installers are **not signed**. Your OS will warn you.
Only install builds you downloaded from the project's own Releases page.

**Windows (SmartScreen).** "Windows protected your PC" appears on first run. Click **More info**,
check that the file name matches what you downloaded, then **Run anyway**.

**macOS (Gatekeeper).** macOS refuses to open an app from an unidentified developer. Either:

- Try to open oIDE once, then open **System Settings > Privacy & Security**, scroll to the message
  about oIDE and click **Open Anyway**. On older macOS versions, right-click (or Control-click) the
  app in Finder and choose **Open**.
- Or remove the quarantine flag in a terminal:

  ```sh
  xattr -dr com.apple.quarantine /Applications/oIDE.app
  ```

**Linux.**

```sh
# AppImage: make it executable and run it (some distributions need libfuse2)
chmod +x oIDE-<version>-linux-x86_64.AppImage
./oIDE-<version>-linux-x86_64.AppImage

# Debian / Ubuntu
sudo apt install ./oIDE-<version>-linux-amd64.deb

# Fedora / RHEL
sudo dnf install ./oIDE-<version>-linux-x86_64.rpm
```

How updates reach each kind of build is described under
[Settings > Updates](/guide/screens/settings#updates).

### Build from source

```sh
git clone https://github.com/oide-dev/oide.git
cd oide
pnpm install
pnpm dev                              # run the app with hot reload
pnpm --filter @oide/desktop dist      # or build an unsigned installer for this OS
```

You need Node 22 or newer and pnpm 9. See [Contributing](/contributing).

## Sign in to Claude Code

oIDE has no login screen. Signing in always happens in Anthropic's own flow, inside the CLI.

1. Open **Settings > Claude Code**. The status card shows whether oIDE found your `claude` binary,
   its path and version, and whether you are signed in.
2. If you are not signed in, click **Sign in**. oIDE opens a terminal running your `claude`; sign in
   there (or type `/login`). oIDE never sees the credentials.
3. If oIDE cannot find the CLI, set **CLI path** in the same section, then **Check again**.

## Open your first project

1. On the Wall, click **Open project** (the + in the Projects sidebar) and pick a git repository.
2. oIDE asks whether you **trust** the project. Trust only repositories you know: an untrusted
   project cannot run its `.oide/setup` command, pre-approve tools through `.oide/permissions.json`,
   start project MCP servers or turn on extensions. You can change this later in
   **Settings > Projects**.

## Spawn your first agent

1. Click **Spawn agent**.
2. Write the goal, for example "Add a --verbose flag to the CLI and document it".
3. Keep the defaults: a new worktree from main, **Auto** mode, and the **Balanced** focus (Opus leads
   and routes subagents by task size).
4. Press **Spawn** (or Ctrl/Cmd+Enter).

A tile appears on the Wall. When the agent needs you, the tile turns amber and shows the request
inline: press **Y** to allow once, **D** to deny, or choose **Always in &lt;project&gt;**. When the
agent finishes, it submits its work for review; click **Review diff**, leave comments, and either
send them back to the agent or merge.

Next: [Using oIDE](/guide/using-oide).
