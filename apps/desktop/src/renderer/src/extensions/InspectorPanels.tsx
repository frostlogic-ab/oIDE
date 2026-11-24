import { useEffect, useMemo, useState } from 'react';
import type { AgentSummary } from '@oide/protocol';
import { tabId, tabPanelProps } from '@oide/ui';
import { ExtensionFrame } from './ExtensionFrame';
import { panelTabId, panelsAt, type PanelRef } from './model';
import { useExtensions } from './store';

export interface InspectorPanelTab {
  id: `ext:${string}`;
  label: string;
  panel: PanelRef;
}

/**
 * Inspector tabs for extension panels (`location: "inspector"`) that are on for the agent's
 * project, plus requests to show one (`ctx.panels.open`, "Open browser preview"). `onTab` is called
 * when a request for this agent arrives.
 */
export function useInspectorPanels(
  agent: AgentSummary,
  onTab: (tab: `ext:${string}`) => void,
  idPrefix: string,
): InspectorPanelTab[] {
  const installed = useExtensions((s) => s.installed);
  const request = useExtensions((s) => s.panelRequest);
  const tabs = useMemo(
    () =>
      panelsAt(installed, 'inspector', agent.projectId).map((panel) => ({
        id: panelTabId(panel.extension, panel.id),
        label: panel.title,
        panel,
      })),
    [installed, agent.projectId],
  );
  useEffect(() => {
    if (!request || (request.agentId && request.agentId !== agent.id)) return;
    if (!tabs.some((t) => t.id === request.tab)) return;
    useExtensions.setState({ panelRequest: null });
    onTab(request.tab);
    // The tab row scrolls when extensions add tabs; bring the requested one into view.
    requestAnimationFrame(() =>
      document
        .getElementById(tabId(idPrefix, request.tab))
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
    );
  }, [request, tabs, agent.id, onTab, idPrefix]);
  return tabs;
}

/**
 * The panel iframes. Each mounts the first time its tab is shown and then stays mounted while
 * hidden, so a preview keeps its page and host messages reach it while another tab is open.
 */
export function InspectorPanelFrames({
  agent,
  tabs,
  tab,
  idPrefix,
}: {
  agent: AgentSummary;
  tabs: InspectorPanelTab[];
  tab: string;
  idPrefix: string;
}) {
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (tab.startsWith('ext:') && !mounted.has(tab)) setMounted(new Set([...mounted, tab]));
  }, [tab, mounted]);
  const context = useMemo(
    () => ({
      agentId: agent.id,
      projectId: agent.projectId,
      ...(agent.worktreePath ? { worktreePath: agent.worktreePath } : {}),
      ...(agent.branch ? { branch: agent.branch } : {}),
    }),
    [agent.id, agent.projectId, agent.worktreePath, agent.branch],
  );
  return (
    <>
      {tabs.map((t) => {
        if (t.id !== tab && !mounted.has(t.id)) return null;
        const shown = t.id === tab;
        return (
          <div
            key={t.id}
            {...tabPanelProps(idPrefix, t.id)}
            hidden={!shown}
            className="flex-1 min-h-0 flex flex-col"
            style={shown ? undefined : { display: 'none' }}
          >
            <ExtensionFrame
              extension={t.panel.extension}
              kind="panel"
              id={t.panel.id}
              title={t.panel.title}
              context={context}
            />
          </div>
        );
      })}
    </>
  );
}
