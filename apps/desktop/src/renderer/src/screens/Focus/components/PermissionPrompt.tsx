import { useEffect, useRef, useState } from 'react';
import type { PermissionRequest } from '@oide/protocol';
import { Button } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../../lib/bridge';
import { useKeymapScope, useShortcutLabel } from '../../../lib/useKeymap';
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

/** Pinned above the composer: Allow once, Always in <project>, Deny (hints show the current bindings). */
export function PermissionPrompt({ agentId, request, projectName, subagentName, onViewSubagent }: PermissionPromptProps) {
  const [busy, setBusy] = useState(false);
  const answered = useRef<string | null>(null);
  const { verb, detail } = permissionCopy(request);
  // Show the real binding (rebindable in Settings > Keys); no hint when the action is unbound.
  const allowKey = useShortcutLabel('permission.allow');
  const denyKey = useShortcutLabel('permission.deny');

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
    // Text left, buttons right; when the session is narrower than 700px (the 1100px window) the
    // text sits above one row of buttons instead of the buttons wrapping one by one.
    <div
      role="group"
      aria-label="Permission request"
      className="flex items-center gap-3 px-3.5 py-3 border border-warn-line bg-warn-bg rounded-xl @max-[700px]:flex-col @max-[700px]:items-stretch @max-[700px]:gap-2.5"
    >
      <div className="flex flex-col gap-1 flex-1 min-w-0">
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
      <div className="flex items-center gap-3 @max-[700px]:gap-2 shrink-0">
      <Button variant="warn" size={32} kbd={allowKey || undefined} disabled={busy} onClick={() => answer('allow')}>
        Allow once
      </Button>
      <Button
        variant="warn-outline"
        size={32}
        disabled={busy || !request.suggestedRule}
        onClick={() => answer('always')}
        title={
          request.suggestedRule
            ? `Allows it now and from now on: saves the rule ${request.suggestedRule} to .oide/permissions.json`
            : 'No rule can be saved for this request: allow it once or deny it'
        }
      >
        Always in {projectName}
      </Button>
      <Button variant="warn-outline" size={32} kbd={denyKey || undefined} disabled={busy} onClick={() => answer('deny')}>
        Deny
      </Button>
      </div>
    </div>
  );
}
