/**
 * Test helpers for the Source control, Review and Files screens: installs the dev mock bridge
 * (no latency, no fake activity) and seeds the stores from it. Not imported by app code.
 */
import { vi } from 'vitest';
import { installFallbackBridge } from '../../lib/bridge';
import { createMockBridge } from '../../lib/mock/mockBridge';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useRouter, type Route } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useGit } from './gitStore';

export async function setupMockApp(route?: Route) {
  const bridge = createMockBridge({ live: false, latency: 0 });
  // The unspied invoke, for tests that override one command and pass the rest through.
  const real = bridge.invoke.bind(bridge);
  const invoke = vi.spyOn(bridge, 'invoke');
  installFallbackBridge(bridge);
  useGit.setState({ byProject: {} });
  useScope.setState({ scope: 'all' });
  await useProjects.getState().load();
  await useAgents.getState().load();
  if (route) useRouter.setState({ route, back: [], forward: [] });
  return { bridge, invoke, real };
}
