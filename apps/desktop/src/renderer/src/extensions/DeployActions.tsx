import { useMemo, useState } from 'react';
import type { AgentSummary } from '@oide/protocol';
import { Button } from '@oide/ui';
import { ipcErrorMessage, oide } from '../lib/bridge';
import { toast } from '../stores/ui';
import { deployResultText, deployTargetsFor } from './model';
import { useExtensions } from './store';

/**
 * Review actions from `contributes.deployTargets` ("Create preview deploy"). Each runs the
 * extension's host code with the agent, its branch and worktree (`extensions.runDeployTarget`).
 */
export function DeployActions({ agent }: { agent: AgentSummary }) {
  const installed = useExtensions((s) => s.installed);
  const targets = useMemo(() => deployTargetsFor(installed, agent.projectId), [installed, agent.projectId]);
  const [busy, setBusy] = useState<string | null>(null);
  if (!targets.length) return null;

  const run = async (extension: string, id: string, title: string) => {
    setBusy(`${extension}:${id}`);
    try {
      const result = await oide.invoke('extensions.runDeployTarget', {
        extension,
        targetId: id,
        agentId: agent.id,
      });
      const { text, url } = deployResultText(title, result);
      toast(
        text,
        'success',
        url
          ? {
              action: {
                label: 'Open',
                run: () => void oide.invoke('shell.openExternal', { url }).catch(() => {}),
              },
            }
          : undefined,
      );
    } catch (err) {
      toast(`${title} failed: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div role="group" aria-label="Deploy" className="flex flex-col gap-2">
      {targets.map((t) => {
        const key = `${t.extension}:${t.id}`;
        return (
          <Button
            key={key}
            variant="secondary"
            size={32}
            className="rounded-md"
            disabled={busy !== null}
            title={`From ${t.displayName}`}
            onClick={() => void run(t.extension, t.id, t.title)}
          >
            {busy === key ? `${t.title}…` : t.title}
          </Button>
        );
      })}
    </div>
  );
}
