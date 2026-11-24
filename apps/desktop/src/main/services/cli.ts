import { detectCli } from '@oide/agent-core';
import { CliInfo } from '@oide/protocol';
import type { SettingsService } from '@oide/store';
import type { Emit } from '../ipc/emit.js';

/**
 * Finds and checks the user's `claude` binary (`--version` / `--help` only; no model call, no
 * credentials). Sign-in state is learned from agents (init → yes, auth error → no). Re-detects
 * when Settings > Claude Code > CLI path changes. `override` (OIDE_CLAUDE_PATH) wins for tests.
 */
export class CliService {
  private info: CliInfo = CliInfo.parse({ found: false });
  private detected: Promise<CliInfo> | undefined;
  private signedIn: CliInfo['signedIn'] = 'unknown';
  private lastPath: string | undefined;

  constructor(
    private readonly o: { settings: SettingsService; emit: Emit; override?: string | undefined },
  ) {
    this.lastPath = o.settings.get().claude.cliPath;
    o.settings.onChange((s) => {
      if (s.claude.cliPath !== this.lastPath) {
        this.lastPath = s.claude.cliPath;
        void this.detect();
      }
    });
  }

  current(): CliInfo {
    return this.info;
  }

  /** The last detection, running one first if none happened yet. */
  ensure(): Promise<CliInfo> {
    return (this.detected ??= this.detect());
  }

  detect(): Promise<CliInfo> {
    const path = this.o.override ?? this.o.settings.get().claude.cliPath;
    const p = detectCli(path || undefined).then((info) => {
      this.info = { ...info, signedIn: this.signedIn };
      this.o.emit('cli.changed', this.info);
      return this.info;
    });
    this.detected = p;
    return p;
  }

  noteSignedIn(state: 'yes' | 'no'): void {
    if (this.signedIn === state) return;
    this.signedIn = state;
    this.info = { ...this.info, signedIn: state };
    this.o.emit('cli.changed', this.info);
  }
}
