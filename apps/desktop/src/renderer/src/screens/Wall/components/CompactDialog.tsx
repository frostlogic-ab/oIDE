import { useState } from 'react';
import { Button, ContextRing, Dialog, contextFraction, contextPercent } from '@oide/ui';
import { useKeymapScope } from '../../../lib/useKeymap';
import { useAgent } from '../../../stores/agents';
import { useSetting } from '../../../stores/settings';
import { compactAgent } from '../actions';
import { useWall } from '../wallState';

/** "Compact this session?" (Main.dc.html). oIDE never sends /compact without this confirm. */
export function CompactDialog() {
  const agentId = useWall((s) => s.compactFor);
  const agent = useAgent(agentId ?? undefined);
  const warnAt = useSetting((s) => s.agents.contextWarnAt, 0.65);
  const dangerAt = useSetting((s) => s.agents.contextSuggestCompactAt, 0.85);
  const [busy, setBusy] = useState(false);
  const close = () => useWall.getState().closeCompact();
  // Modal: J / K / N / Y / D on the Wall must not act while the confirm is open.
  useKeymapScope('compact-confirm', {}, { modal: true, enabled: !!agent });
  if (!agent) return null;
  const used = contextFraction(agent.contextUsed, agent.contextWindow);
  const confirm = async () => {
    setBusy(true);
    const ok = await compactAgent(agent.id, agent.title);
    setBusy(false);
    if (ok) close();
  };
  return (
    <Dialog
      open
      onClose={close}
      title="Compact this session?"
      description={`${agent.title} · context ${contextPercent(used)}% full`}
      icon={
        <span className="w-11 h-11 flex items-center justify-center">
          <ContextRing used={used} size={44} warnAt={warnAt} dangerAt={dangerAt} />
        </span>
      }
      footer={
        <>
          <Button size={32} className="text-[13px]! px-3.5! rounded-md!" onClick={close}>
            Cancel
          </Button>
          <Button size={32} variant="primary" className="text-[13px]! px-3.5! rounded-md!" disabled={busy} onClick={() => void confirm()}>
            Compact
          </Button>
        </>
      }
    >
      <p className="m-0 text-[13px] leading-[1.55] text-ink-2">
        oIDE will send <span className="font-mono text-[12px] text-ink">/compact</span> to this agent. Claude summarizes the conversation so far and continues from the
        summary, freeing up context. Earlier messages are replaced by that summary.
      </p>
    </Dialog>
  );
}
