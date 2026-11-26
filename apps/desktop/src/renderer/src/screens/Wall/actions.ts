/**
 * Tile actions → IPC. Each returns true on success and toasts the error otherwise, so tiles and
 * keymap handlers share one code path. Permission answers always quote the exact pending request
 * id (main rejects anything else).
 */
import { useSyncExternalStore } from 'react';
import type { MessageAttachment } from '@oide/protocol';
import { attachmentOnlyText } from '../../lib/attachments';
import { ipcErrorCode, ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';

export type PermissionChoice = 'allow' | 'always' | 'deny';

async function run(fn: () => Promise<unknown>, failure: string): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    const code = ipcErrorCode(err);
    toast(code === 'not_implemented' || code === 'unavailable' ? `${failure}: not available yet` : `${failure}: ${ipcErrorMessage(err)}`, 'error');
    return false;
  }
}

export function answerPermission(agentId: string, requestId: string, choice: PermissionChoice): Promise<boolean> {
  const answer =
    choice === 'deny'
      ? ({ requestId, behavior: 'deny', message: 'Denied by user' } as const)
      : ({ requestId, behavior: 'allow', always: choice === 'always' } as const);
  return run(() => oide.invoke('agents.answerPermission', { agentId, answer }), 'Could not answer the permission prompt');
}

export function sendReply(agentId: string, text: string, attachments: readonly MessageAttachment[] = []): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed && !attachments.length) return Promise.resolve(false);
  const message = attachments.length ? { kind: 'text' as const, text: trimmed || attachmentOnlyText(attachments), attachments: [...attachments] } : { kind: 'text' as const, text: trimmed };
  return run(() => oide.invoke('agents.send', { agentId, message }), 'Could not send the reply');
}

export async function compactAgent(agentId: string, title: string): Promise<boolean> {
  const ok = await run(() => oide.invoke('agents.compact', { agentId }), 'Could not compact');
  if (ok) toast(`Sent /compact to ${title}. Compacting…`, 'info', { agentId });
  return ok;
}

export function resumeAgent(agentId: string): Promise<boolean> {
  return run(() => oide.invoke('agents.resume', { agentId }), 'Could not resume');
}

/**
 * Idempotent in main: a branch that already has a PR gets that PR back (`existing`), never an error.
 * Main writes the title and body (the agent's draft, else the project's PR template and title rules).
 */
export async function openPullRequest(agentId: string): Promise<boolean> {
  let url = '';
  const ok = await run(async () => {
    const r = await oide.invoke('git.openPr', { agentId });
    url = r.url;
    if (r.existing) toast(`This branch already has pull request${r.number ? ` #${r.number}` : ''}: opening it.`, 'info', { agentId });
  }, 'Could not open a pull request');
  if (ok && url) await run(() => oide.invoke('shell.openExternal', { url }), 'Could not open the pull request page');
  return ok;
}

/**
 * Push to PR: follow-up work after the PR was opened (new commits, and files the agent did not
 * commit, which main commits on its behalf) goes up to the same pull request.
 */
export async function pushToPullRequest(agentId: string): Promise<boolean> {
  let result: { url: string; number: number; committed: boolean; pushed: number } | undefined;
  const ok = await run(async () => {
    result = await oide.invoke('git.pushToPr', { agentId });
  }, 'Could not push to the pull request');
  if (ok && result) {
    const r = result;
    const view = { label: 'View', run: () => void oide.invoke('shell.openExternal', { url: r.url }).catch(() => {}) };
    if (r.pushed === 0) toast(`Pull request #${r.number} is already up to date.`, 'info', { agentId });
    else toast(`Pushed ${r.pushed} ${r.pushed === 1 ? 'commit' : 'commits'} to pull request #${r.number}${r.committed ? ' (uncommitted files committed first)' : ''}.`, 'success', { agentId, action: view });
  }
  return ok;
}

// ---------- shared clock (one interval for every tile) ----------

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      subscribers.forEach((fn) => fn());
    }, 30_000);
  }
  return () => {
    subscribers.delete(cb);
    if (!subscribers.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time, refreshed every 30 s (durations on tiles: "Running · 14m"). */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
