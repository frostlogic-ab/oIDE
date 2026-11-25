import type { AgentSummary, MergePrediction } from '@oide/protocol';
import { Badge, Button, Dialog, Icon } from '@oide/ui';
import { formatDuration, plural } from '../../lib/format';
import { fileList, freshnessText } from '../../stores/mergePrediction';
import { useNow } from '../Wall/actions';

export interface MergeDialogState {
  step: 'confirm' | 'busy' | 'conflicts' | 'asking';
  /** Files the real merge stopped on (step `conflicts`). */
  conflicts: string[];
  /** Where "Ask to resolve" came from: the prediction, or a merge that stopped. */
  from?: 'prediction' | 'merge';
}

export interface MergeDialogProps {
  state: MergeDialogState | null;
  /** The agent's title, shortened for the button. */
  agentTitle: string;
  branch: string;
  target: string;
  prediction?: MergePrediction;
  predicting: boolean;
  /** The agent is already resolving conflicts oIDE sent it. */
  resolving: boolean;
  sensitiveFiles: Array<{ path: string; reason: string }>;
  onClose(): void;
  onMerge(): void;
  onAsk(from: 'prediction' | 'merge'): void;
  onHandOff(files: string[]): void;
}

/**
 * "Merge into main?": predicts first (git merge-tree, no checkout touched). When the merge would
 * conflict, the primary action is "Ask <agent> to resolve" and "Merge anyway" is secondary; when
 * the real merge stops on conflicts (prediction missed them or could not run), the result offers
 * the same action. Merging never happens on its own: the user clicks Merge again.
 */
export function MergeDialog({ state, agentTitle, branch, target, prediction, predicting, resolving, sensitiveFiles, onClose, onMerge, onAsk, onHandOff }: MergeDialogProps) {
  const step = state?.step;
  const busy = step === 'busy' || step === 'asking';
  const isResult = step === 'conflicts' || (step === 'asking' && state?.from === 'merge');
  const predicted = prediction?.status === 'conflicts' ? prediction : undefined;
  const canAsk = prediction ? prediction.canAsk && prediction.status !== 'unavailable' : false;
  const resultFiles = state?.conflicts.length ? state.conflicts : (predicted?.files ?? []);
  const askLabel = step === 'asking' ? 'Sending…' : `Ask ${agentTitle} to resolve`;
  const sha = prediction?.target?.sha.slice(0, 7);

  let description: string;
  if (isResult) description = `Nothing changed in ${target}: oIDE aborted the merge.`;
  else if (!prediction && predicting) description = `Checking whether ${branch} merges cleanly into ${target}…`;
  else if (predicted) description = `Merging will conflict in ${plural(predicted.files.length, 'file')}: ${fileList(predicted.files)}.`;
  else if (prediction?.status === 'clean') description = `Runs git merge --no-ff ${branch} in the main checkout. It merges cleanly into ${target}${sha ? ` @ ${sha}` : ''}.`;
  else description = `Runs git merge --no-ff ${branch} in the main checkout. It stops on conflicts and leaves ${target} as it was.`;

  const askNote = canAsk
    ? `oIDE sends ${agentTitle} the conflicts as a message, to resolve in its own worktree. Merge again once it submits for review.`
    : prediction?.askBlocked;

  return (
    <Dialog
      open={state !== null}
      onClose={() => !busy && onClose()}
      title={isResult ? 'The merge stopped on conflicts' : `Merge into ${target}?`}
      description={description}
      width={480}
      footer={
        isResult ? (
          <>
            <Button variant="secondary" size={32} disabled={busy} onClick={onClose}>
              Close
            </Button>
            {canAsk ? (
              <Button variant="primary" size={32} disabled={busy} onClick={() => onAsk('merge')}>
                {askLabel}
              </Button>
            ) : (
              <Button variant="primary" size={32} disabled={busy} onClick={() => onHandOff(resultFiles)}>
                Hand them to a new agent
              </Button>
            )}
          </>
        ) : predicted ? (
          <>
            <Button variant="secondary" size={32} disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant={canAsk ? 'secondary' : 'primary'} size={32} disabled={busy} onClick={onMerge}>
              {step === 'busy' ? 'Merging…' : 'Merge anyway'}
            </Button>
            {canAsk && (
              <Button variant="primary" size={32} disabled={busy} onClick={() => onAsk('prediction')}>
                {askLabel}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="secondary" size={32} disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size={32} disabled={busy} onClick={onMerge}>
              {step === 'busy' ? 'Merging…' : 'Merge'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-2.5">
        {!isResult && sensitiveFiles.length > 0 && <SensitiveWarning files={sensitiveFiles} />}
        {!isResult && prediction?.mainDirty && prediction.mainDirty.length > 0 && (
          <div role="note" aria-label="Uncommitted changes in the main checkout" className="flex gap-2 items-start p-2.5 rounded-md border border-warn-line bg-warn-bg text-[12.5px] leading-normal text-ink-2">
            <Icon name="warning" size={16} className="text-warn mt-px shrink-0" />
            <span>
              The main checkout has uncommitted changes in {plural(prediction.mainDirty.length, 'file')} ({fileList(prediction.mainDirty)}). git refuses to merge over the ones this merge touches: commit or stash them first.
            </span>
          </div>
        )}
        {!isResult && prediction?.status === 'unknown' && <span className="text-[12px] text-ink-3 leading-normal">{prediction.reason ?? 'oIDE could not predict conflicts.'}</span>}
        {(isResult || predicted) && (
          <>
            <ConflictList files={isResult ? resultFiles : predicted!.files} prediction={prediction} />
            {resolving ? (
              <span className="text-[12.5px] text-warn leading-normal">{agentTitle} is already resolving merge conflicts. Wait until it submits for review again, then merge.</span>
            ) : (
              askNote && <span className="text-[12.5px] text-ink-2 leading-normal">{askNote}</span>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

function ConflictList({ files, prediction }: { files: string[]; prediction?: MergePrediction }) {
  const binary = new Set(prediction?.binary ?? []);
  const submodules = new Set(prediction?.submodules ?? []);
  if (!files.length) return <span className="text-[12.5px] text-ink-3">git did not say which files conflict.</span>;
  return (
    <ul aria-label="Conflicted files" className="list-none m-0 p-0 flex flex-col gap-1 max-h-[180px] overflow-auto">
      {files.map((f) => (
        <li key={f} className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[12px] text-bad-bright truncate" title={f}>
            {f}
          </span>
          {binary.has(f) && <Badge tone="warn">binary</Badge>}
          {submodules.has(f) && <Badge tone="warn">submodule</Badge>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Above Review's merge buttons: "Resolving merge conflicts" while the agent works on conflicts oIDE
 * sent it, otherwise how its branch stands against the main checkout ("Behind main by 2 commits,
 * would conflict in 1 file").
 */
export function MergeStatus({ agent, prediction }: { agent: AgentSummary; prediction?: MergePrediction }) {
  const now = useNow();
  const mc = agent.mergeConflict;
  if (mc) {
    return (
      <div role="status" className="flex flex-col gap-1 text-[12px] leading-normal">
        <Badge tone="warn" icon="branch" className="self-start">
          Resolving merge conflicts
        </Badge>
        <span className="text-ink-3">
          Sent {plural(mc.files.length, 'conflicted file')} with {mc.target} {formatDuration(now - mc.sentAt)} ago. Merge again once it submits for review.
        </span>
      </div>
    );
  }
  const text = freshnessText(prediction);
  if (!text) return null;
  const conflicts = prediction?.status === 'conflicts';
  return (
    <span role="status" aria-label={`Merge status: ${text}`} className={`flex items-center gap-1.5 text-[12px] ${conflicts ? 'text-warn' : 'text-ink-3'}`}>
      <Icon name="branch" size={14} />
      {text}
    </span>
  );
}

/** SEC-12: the agent changed files that widen what agents, git or MCP servers may do. */
export function SensitiveWarning({ files, onJump }: { files: Array<{ path: string; reason: string }>; onJump?: (path: string) => void }) {
  return (
    <div role="alert" className="flex flex-col gap-1.5 p-3 rounded-lg border border-warn text-[12.5px] leading-normal">
      <span className="flex gap-2 items-center font-semibold text-warn">
        <Icon name="alert-circle" size={16} />
        Changes oIDE, Claude Code or git configuration
      </span>
      <span className="text-ink-2">Merging these can change what agents may do without asking. Read them before you merge.</span>
      <ul className="list-none m-0 p-0 flex flex-col gap-1">
        {files.map((f) => (
          <li key={f.path} className="min-w-0">
            {onJump ? (
              <button type="button" onClick={() => onJump(f.path)} className="bg-transparent border-0 p-0 text-left font-mono text-[12px] text-ink cursor-pointer hover:underline" title={f.reason}>
                {f.path}
              </button>
            ) : (
              <span className="font-mono text-[12px] text-ink" title={f.reason}>
                {f.path}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
