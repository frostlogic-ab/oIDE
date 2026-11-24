import { Button, ContextRing, Dialog, contextColor, contextLevel, contextPercent } from '@oide/ui';
import { useKeymapScope } from '../../../lib/useKeymap';

export interface CompactDialogProps {
  open: boolean;
  agentName: string;
  /** Context fraction 0–1. */
  used: number;
  warnAt?: number;
  dangerAt?: number;
  onCancel(): void;
  onConfirm(): void;
}

/** "Compact this session?" (Focus.dc.html). oIDE never sends /compact without it. */
export function CompactDialog({ open, agentName, used, warnAt, dangerAt, onCancel, onConfirm }: CompactDialogProps) {
  // Modal: J / K / Y / D must not reach the screen underneath while the confirm is open.
  useKeymapScope('focus-compact', {}, { modal: true, enabled: open });
  const color = contextColor(contextLevel(used, { warnAt, dangerAt }));
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="Compact this session?"
      description={`${agentName} · context ${contextPercent(used)}% full`}
      icon={
        <div className="w-11 h-11 flex items-center justify-center">
          <ContextRing used={used} size={44} strokeWidth={4} color={color} />
        </div>
      }
      footer={
        <>
          <Button size={32} className="!rounded-md !px-3.5 !text-[13px]" onClick={onCancel}>
            Cancel
          </Button>
          <Button size={32} variant="primary" className="!rounded-md !px-3.5 !text-[13px]" onClick={onConfirm}>
            Compact
          </Button>
        </>
      }
    >
      <p className="m-0 text-[13px] leading-[1.55] text-ink-2">
        oIDE will send <span className="font-mono text-[12px] text-ink">/compact</span> to this agent. Claude summarizes the conversation so far and continues from the summary,
        freeing up context. Earlier messages are replaced by that summary.
      </p>
    </Dialog>
  );
}
