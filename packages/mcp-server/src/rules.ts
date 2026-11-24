/** Human summaries and "Always" rule suggestions for permission prompts. */

function str(input: unknown, key: string): string | undefined {
  if (input && typeof input === 'object' && key in input) {
    const v = (input as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function oneLine(s: string, n = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Short summary for the tile, e.g. "Run npm test", "Edit src/x.ts". */
export function summarizeTool(toolName: string, input: unknown): string {
  const path = str(input, 'file_path') ?? str(input, 'notebook_path') ?? str(input, 'path');
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      return oneLine(`Run ${str(input, 'command') ?? 'a command'}`);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return oneLine(`Edit ${path ?? 'a file'}`);
    case 'Write':
      return oneLine(`Write ${path ?? 'a file'}`);
    case 'Read':
      return oneLine(`Read ${path ?? 'a file'}`);
    case 'WebFetch':
      return oneLine(`Fetch ${str(input, 'url') ?? 'a URL'}`);
    case 'WebSearch':
      return oneLine(`Search the web for ${str(input, 'query') ?? ''}`);
    case 'mcp__oide__submit_for_review':
      return 'Submit for review';
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
      return m ? `Use ${m[2]} (${m[1]})` : `Use ${toolName}`;
    }
  }
}

/**
 * Suggested rule for "Always in <project>", in Claude Code's permission rule syntax.
 * Bash → `Bash(npm test)` (the exact command); WebFetch → `WebFetch(domain:host)`; others → the tool name.
 */
export function suggestRule(toolName: string, input: unknown): string | undefined {
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = str(input, 'command')?.trim();
      if (!cmd || cmd.includes('\n') || cmd.length > 200) return undefined;
      return `${toolName}(${cmd})`;
    }
    case 'WebFetch': {
      const url = str(input, 'url');
      try {
        return url ? `WebFetch(domain:${new URL(url).hostname})` : undefined;
      } catch {
        return undefined;
      }
    }
    default:
      return toolName;
  }
}
