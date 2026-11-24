import { useEffect, useRef, useState } from 'react';
import type { PermissionRequest } from '@oide/protocol';
import { Button } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../../lib/bridge';
import { useKeymapScope } from '../../../lib/useKeymap';
import { toast } from '../../../stores/ui';
import { permissionCopy } from '../model/focus';

export type PermissionChoice = 'allow' | 'always' | 'deny';

/** Answer one pending request. The exact `requestId` is quoted; main refuses any other id. */
export async function answerPermission(agentId: string, requestId: string, choice: PermissionChoice): Promise<void> {
  await oide.invoke('agents.answerPermission', {
    agentId,
    answer: choice === 'deny' ? { requestId, behavior: 'deny', message: 'Denied by user' } : { requestId, behavior: 'allow', always: choice === 'always' },
  });
}

export interface PermissionPromptProps {
  agentId: string;
  request: PermissionRequest;
  projectName: string;
  /** Name of the subagent that asked, when the prompt belongs to one. */
  subagentName?: string;
  onViewSubagent?: () => void;
}

/** Pinned above the composer: Allow once (Y), Always in <project>, Deny (D). */
export function PermissionPrompt({ agentId, request, projectName, subagentName, onViewSubagent }: PermissionPromptProps) {
  const [busy, setBusy] = useState(false);
  const answered = useRef<string | null>(null);
  const { verb, detail } = permissionCopy(request);

  useEffect(() => {
    answered.current = null;
    setBusy(false);
  }, [request.requestId]);

  const answer = (choice: PermissionChoice) => {
    // One answer per request id, even if Y is pressed twice.
    if (answered.current === request.requestId) return;
    answered.current = request.requestId;
    setBusy(true);
    answerPermission(agentId, request.requestId, choice).catch((err: unknown) => {
      answered.current = null;
      setBusy(false);
      toast(ipcErrorMessage(err), 'error');
    });
  };

  useKeymapScope('focus-permission', {
    'permission.allow': () => answer('allow'),
    'permission.deny': () => answer('deny'),
  });

  return (
    <div role="group" aria-label="Permission request" className="flex items-center gap-3 px-3.5 py-3 border border-warn-line bg-warn-bg rounded-xl flex-wrap">
      <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
        <span className="text-[12px] text-warn font-semibold">
          {subagentName ? (
            <>
              Subagent{' '}
              <button type="button" onClick={onViewSubagent} className="border-0 bg-transparent p-0 text-warn font-semibold text-[12px] underline">
                {subagentName}
              </button>{' '}
              {verb}
            </>
          ) : (
            <>This agent {verb}</>
          )}
        </span>
        <span className="font-mono text-[12.5px] text-ink break-all">{detail}</span>
      </div>
      <Button variant="warn" size={32} kbd="Y" disabled={busy} onClick={() => answer('allow')}>
        Allow once
      </Button>
      <Button
        variant="warn-outline"
        size={32}
        disabled={busy}
        onClick={() => answer('always')}
        title={request.suggestedRule ? `Saves the rule ${request.suggestedRule} to .oide/permissions.json` : undefined}
      >
        Always in {projectName}
      </Button>
      <Button variant="warn-outline" size={32} kbd="D" disabled={busy} onClick={() => answer('deny')}>
        Deny
      </Button>
    </div>
  );
}
