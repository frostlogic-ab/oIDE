import { useEffect, useState } from 'react';
import type { Settings } from '@oide/protocol';
import { cn } from '@oide/ui';
import { H1, Rd, Row, Sec, describedBy, inp, inpInvalid, savePatch } from './ui';

/**
 * A number field that saves on every valid change and shows why an invalid value is not saved.
 * `validate` returns an error message or undefined.
 */
function NumberSetting({
  title,
  desc,
  value,
  validate,
  onSave,
  suffix,
  min,
  max,
}: {
  title: string;
  desc: string;
  value: number;
  validate: (n: number) => string | undefined;
  onSave: (n: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(String(value));
    setError(undefined);
  }, [value]);

  const change = (raw: string) => {
    setDraft(raw);
    const n = Number(raw);
    const msg = raw.trim() === '' || !Number.isInteger(n) ? 'Enter a whole number' : validate(n);
    setError(msg);
    if (!msg && n !== value) onSave(n);
  };

  return (
    <Row title={title} desc={desc} error={error}>
      {({ titleId, descId, errorId }) => (
        <span className="flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            aria-labelledby={titleId}
            aria-describedby={describedBy(descId, errorId)}
            aria-invalid={error ? true : undefined}
            className={cn(inp, 'w-20', error && inpInvalid)}
            value={draft}
            onChange={(e) => change(e.target.value)}
          />
          {suffix && <span className="text-[12.5px] text-ink-3">{suffix}</span>}
        </span>
      )}
    </Row>
  );
}

export function AgentsSection({ settings }: { settings: Settings }) {
  const a = settings.agents;
  const warnPct = Math.round(a.contextWarnAt * 100);
  const compactPct = Math.round(a.contextSuggestCompactAt * 100);

  return (
    <>
      <H1>Agents</H1>
      <Rd>How oIDE runs many sessions at once.</Rd>
      <Sec>Running</Sec>
      <NumberSetting
        title="Max agents running at once"
        desc="Extra agents wait in a queue on the wall."
        value={a.maxRunning}
        min={1}
        max={32}
        validate={(n) => (n < 1 || n > 32 ? 'Choose between 1 and 32' : undefined)}
        onSave={(n) => void savePatch({ agents: { maxRunning: n } })}
      />
      <Row title="Worktree location" desc="Where each agent's git worktree is created.">
        {({ titleId, descId }) => (
          <select
            aria-labelledby={titleId}
            aria-describedby={descId}
            className={cn(inp, 'w-[260px]')}
            value={a.worktreeLocation}
            onChange={(e) => void savePatch({ agents: { worktreeLocation: e.target.value } })}
          >
            <option value="app-data">App data folder (outside the repo)</option>
            <option value="sibling">Next to the repo (&lt;repo&gt;.worktrees)</option>
          </select>
        )}
      </Row>
      <Row title="Clean up worktrees" desc="After an agent's work is merged or discarded.">
        {({ titleId, descId }) => (
          <select aria-labelledby={titleId} aria-describedby={descId} className={inp} value={a.cleanup} onChange={(e) => void savePatch({ agents: { cleanup: e.target.value } })}>
            <option value="after-7-days">After 7 days</option>
            <option value="right-away">Right away</option>
            <option value="never">Never</option>
          </select>
        )}
      </Row>
      <NumberSetting
        title="Fetch from remotes every"
        desc="How often oIDE runs git fetch for each open project. 0 turns it off."
        value={a.fetchIntervalMinutes}
        min={0}
        suffix="minutes"
        validate={(n) => (n < 0 || n > 1440 ? 'Choose between 0 and 1440' : undefined)}
        onSave={(n) => void savePatch({ agents: { fetchIntervalMinutes: n } })}
      />

      <Sec>Context</Sec>
      <NumberSetting
        title="Context ring turns amber at"
        desc="The ring on each tile changes colour as context fills."
        value={warnPct}
        min={1}
        max={99}
        suffix="%"
        validate={(n) => (n < 1 || n > 99 ? 'Choose between 1 and 99' : n >= compactPct ? `Must be below the /compact level (${compactPct}%)` : undefined)}
        onSave={(n) => void savePatch({ agents: { contextWarnAt: n / 100 } })}
      />
      <NumberSetting
        title="Suggest /compact at"
        desc="The tile shows a compact hint. oIDE never compacts without you confirming."
        value={compactPct}
        min={2}
        max={100}
        suffix="%"
        validate={(n) => (n < 2 || n > 100 ? 'Choose between 2 and 100' : n <= warnPct ? `Must be above the amber level (${warnPct}%)` : undefined)}
        onSave={(n) => void savePatch({ agents: { contextSuggestCompactAt: n / 100 } })}
      />

      <Sec>Notifications</Sec>
      <Row title="Notify me when an agent" desc="Desktop notifications while oIDE is in the background.">
        {({ titleId }) => (
          <fieldset aria-labelledby={titleId} className="m-0 p-0 border-0 flex flex-col gap-1.5">
            {(
              [
                ['needsPermission', 'needs permission or has a question'],
                ['readyForReview', 'is ready for review'],
                ['error', 'hits an error'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex gap-2 items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={a.notifications[key]}
                  onChange={(e) => void savePatch({ agents: { notifications: { [key]: e.target.checked } } })}
                />
                {label}
              </label>
            ))}
          </fieldset>
        )}
      </Row>
    </>
  );
}
