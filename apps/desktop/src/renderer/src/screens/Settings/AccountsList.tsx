import { useEffect, useState } from 'react';
import { ACCOUNT_LABEL_MAX, DEFAULT_ACCOUNT, accountKeys, accountLabel, spawnDefaultAccount, type AccountKey, type AccountUsage, type Settings } from '@oide/protocol';
import { Button, Dialog, cn } from '@oide/ui';
import { ipcErrorMessage } from '../../lib/bridge';
import { useAccounts } from '../../stores/accounts';
import { useCli } from '../../stores/cli';
import { toast } from '../../stores/ui';
import { Rd, inpSm, outlineBtn, savePatch } from './ui';

const smallBtn = 'h-7 px-2.5 rounded-sm border border-line-3 bg-transparent text-ink text-[12px] hover:bg-raised';
const ghostBtn = 'h-7 px-2.5 rounded-sm border-0 bg-transparent text-ink-3 text-[12px] hover:text-ink';

/**
 * Settings › Claude Code › Accounts (ADR 0021). Each account is its own Claude Code sign-in (a
 * CLAUDE_CONFIG_DIR main makes from the id). The first row is the CLI's own config. Sign-in opens a
 * terminal running `claude` for that account; oIDE never sees credentials.
 */
export function AccountsList({ settings }: { settings: Settings }) {
  const usage = useAccounts((s) => s.usage);
  const cliSignedIn = useCli((s) => s.info?.signedIn ?? 'unknown');
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; label: string } | null>(null);
  const accounts = settings.accounts;
  const keys = accountKeys(accounts);
  const spawnDefault = spawnDefaultAccount(accounts);
  const byKey = new Map(usage.map((u) => [u.accountId, u]));

  const signIn = async (id: AccountKey) => {
    try {
      await useAccounts.getState().openSignIn(id);
      toast('A terminal running claude opened. Sign in there; oIDE never sees your credentials.', 'info');
    } catch (err) {
      toast(`Could not open the sign-in terminal: ${ipcErrorMessage(err)}`, 'error');
    }
  };
  const remove = async (id: string, label: string) => {
    setConfirmRemove(null);
    try {
      await useAccounts.getState().remove(id);
      toast(`Removed ${label} from oIDE. Its sign-in folder stays on this computer.`, 'info');
    } catch (err) {
      toast(`Could not remove ${label}: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5 mt-[22px]">
        <h2 className="m-0 flex-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Accounts</h2>
        <button type="button" className={cn(outlineBtn, 'rounded-md')} onClick={() => setAdding(true)} aria-expanded={adding} disabled={accounts.list.length >= 16}>
          + Add account
        </button>
      </div>
      <Rd className="mt-1.5">
        Each account is a separate Claude Code sign-in, for example a work plan and a personal one. You pick the account when you start an agent; an agent keeps it for its whole life. You choose: oIDE never moves an
        agent to another account when one reaches its limit.
      </Rd>

      <ul className="list-none m-0 p-0 flex flex-col gap-2 mt-3" aria-label="Claude Code accounts">
        {keys.map((key) => {
          const label = accountLabel(accounts, key) ?? key;
          // The default account's sign-in is also learned by the CLI service (before any account existed).
          const signedIn = byKey.get(key)?.signedIn ?? (key === DEFAULT_ACCOUNT ? cliSignedIn : 'unknown');
          return (
            <li key={key} className="flex items-center gap-2.5 flex-wrap px-3.5 py-2.5 rounded-lg border border-line-2 bg-card">
              <LabelInput value={label} accountKey={key} />
              {key === DEFAULT_ACCOUNT && <span className="px-2 py-0.5 rounded-sm bg-selected text-[11.5px] text-ink-2">CLI's own sign-in</span>}
              <SignInState state={signedIn} />
              <div className="flex-1" />
              <label className="flex items-center gap-1.5 text-[12px] text-ink-2 cursor-pointer">
                <input
                  type="radio"
                  name="spawn-default-account"
                  className="accent-accent"
                  checked={spawnDefault === key}
                  onChange={() => void savePatch({ accounts: { spawnDefault: key } })}
                />
                Default for new agents
              </label>
              <button type="button" className={smallBtn} onClick={() => void signIn(key)} aria-label={`Sign in to ${label}`}>
                {signedIn === 'yes' ? 'Sign in again' : 'Sign in'}
              </button>
              {key !== DEFAULT_ACCOUNT && (
                <button type="button" className={ghostBtn} onClick={() => setConfirmRemove({ id: key, label })} aria-label={`Remove ${label}`}>
                  Remove
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {adding && <AddAccountForm onClose={() => setAdding(false)} onAdded={(id) => void signIn(id)} />}

      <Dialog
        open={Boolean(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
        title={`Remove ${confirmRemove?.label ?? ''}?`}
        description="oIDE forgets this account. Its sign-in folder stays on this computer, so you can sign out first with /logout in its sign-in terminal. Agents still using it must be archived first."
        footer={
          <>
            <Button size={32} onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button size={32} variant="danger" onClick={() => confirmRemove && void remove(confirmRemove.id, confirmRemove.label)}>
              Remove
            </Button>
          </>
        }
      />
    </>
  );
}

function SignInState({ state }: { state: AccountUsage['signedIn'] }) {
  const meta = {
    yes: { text: 'Signed in', cls: 'text-ok' },
    no: { text: 'Not signed in', cls: 'text-warn' },
    unknown: { text: 'Sign-in checked when an agent starts', cls: 'text-ink-3' },
  }[state];
  return (
    <span role="status" className={cn('text-[12px]', meta.cls)}>
      {meta.text}
    </span>
  );
}

function LabelInput({ value, accountKey }: { value: string; accountKey: AccountKey }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    const v = draft.trim();
    if (!v || v === value) return setDraft(value);
    try {
      await useAccounts.getState().rename(accountKey, v);
    } catch (err) {
      toast(`Could not rename: ${ipcErrorMessage(err)}`, 'error');
      setDraft(value);
    }
  };
  return (
    <input
      type="text"
      aria-label="Account name"
      maxLength={ACCOUNT_LABEL_MAX}
      className={cn(inpSm, 'h-[28px] w-[180px] font-semibold')}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => e.key === 'Enter' && void commit()}
    />
  );
}

function AddAccountForm({ onClose, onAdded }: { onClose: () => void; onAdded: (id: AccountKey) => void }) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const v = label.trim();
    if (!v) return;
    setBusy(true);
    try {
      const a = await useAccounts.getState().add(v);
      onClose();
      onAdded(a.id);
    } catch (err) {
      toast(`Could not add the account: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex items-center gap-2 mt-2 px-3.5 py-2.5 rounded-lg border border-line-2 bg-card flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="flex items-center gap-2 text-[12.5px]">
        Name
        <input autoFocus type="text" maxLength={ACCOUNT_LABEL_MAX} className={cn(inpSm, 'w-[200px]')} placeholder="Work" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <Rd className="flex-1 min-w-[200px]">A sign-in terminal opens next. Sign in there with the other account.</Rd>
      <button type="button" className={ghostBtn} onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className={smallBtn} disabled={busy || !label.trim()}>
        Add and sign in
      </button>
    </form>
  );
}
