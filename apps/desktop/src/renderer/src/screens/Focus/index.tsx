/**
 * PLACEHOLDER: Focus view (docs/wiki/raw/design/Focus.dc.html), implemented in wave 2.
 * Already wired: J / K / N / Esc through the keymap, the agent from the route, its event tail.
 */
import { ContextRingButton, StatusLabel, contextFraction } from '@oide/ui';
import { ScreenPlaceholder } from '../../components/ScreenPlaceholder';
import { useKeymapScope } from '../../lib/useKeymap';
import { nextNeedsYou, stepAgent, useAgent, useAgentEvents, useAgentHistory, useAgentsInScope } from '../../stores/agents';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';

export default function FocusScreen() {
  const route = useRouter((s) => s.route);
  const agentId = route.screen === 'focus' ? route.params.agentId : undefined;
  const agent = useAgent(agentId);
  useAgentHistory(agentId);
  const events = useAgentEvents(agentId);
  const scope = useScope((s) => s.scope);
  const agents = useAgentsInScope(scope);
  const { replace, navigate } = useRouter.getState();

  useKeymapScope('focus', {
    'agent.next': () => {
      const a = stepAgent(agents, agentId, 1);
      if (a) replace('focus', { agentId: a.id });
    },
    'agent.prev': () => {
      const a = stepAgent(agents, agentId, -1);
      if (a) replace('focus', { agentId: a.id });
    },
    'agent.nextNeedsYou': () => {
      const a = nextNeedsYou(agents, agentId);
      if (a) replace('focus', { agentId: a.id });
    },
    'view.back': () => navigate('wall'),
  });

  return (
    <ScreenPlaceholder title={agent?.title ?? 'Focus'} design="Focus.dc.html" icon="agents" description="Transcript, subagent tree, pinned permission prompt, composer and inspector.">
      {agent && (
        <div className="flex flex-col gap-3 text-ink-2">
          <div className="flex items-center gap-3">
            <StatusLabel status={agent.status} />
            <ContextRingButton variant="header" used={contextFraction(agent.contextUsed, agent.contextWindow)} subject={agent.title} />
          </div>
          <p className="m-0 text-[12.5px] text-ink-3">
            {events.length} events loaded. J / K move between agents, N jumps to the next that needs you, Esc goes back.
          </p>
        </div>
      )}
    </ScreenPlaceholder>
  );
}
