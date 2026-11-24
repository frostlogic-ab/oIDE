import { useEffect, useState } from 'react';
import type { Project, Settings } from '@oide/protocol';
import { cn } from '@oide/ui';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { H1, Rd, Row, Sec, inp, inpSm, inpInvalid, savePatch } from './ui';

type Rules = { allow: string[]; ask: string[]; deny: string[] };

/** `Bash(npm install:*)` → `npm install *`; other tools keep their rule text. */
export function ruleLabel(rule: string): string {
  const m = /^Bash\((.*)\)$/.exec(rule.trim());
  if (!m) return rule;
  return m[1]!.replace(/:\*$/, ' *');
}

/** What the user types → a CLI permission rule. `npm test` → `Bash(npm test)`, `npm install *` → `Bash(npm install:*)`. */
export function toRule(input: string): string {
  const v = input.trim();
  if (/^[A-Za-z_][\w-]*\(.*\)$/.test(v) || /^mcp__/.test(v) || /^[A-Z][A-Za-z]+$/.test(v)) return v;
  return `Bash(${v.replace(/\s\*$/, ':*')})`;
}

export function PermissionsSection({ settings, projects }: { settings: Settings; projects: Project[] }) {
  const d = settings.permissions.defaults;
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [rules, setRules] = useState<Rules | null>(null);
  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setRules(null);
    void invokeOr('settings.projectPermissions', { projectId }, { allow: [], ask: [], deny: [] }).then((r) => live && setRules(r));
    return () => {
      live = false;
    };
  }, [projectId]);

  const project = projects.find((p) => p.id === projectId);
  const save = async (next: Rules) => {
    const prev = rules;
    setRules(next);
    try {
      await oide.invoke('settings.saveProjectPermissions', { projectId, ...next });
    } catch (err) {
      setRules(prev);
      toast(`Could not save rules for ${project?.name ?? projectId}: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const select = (label: string, key: keyof typeof d, options: Array<[string, string]>) => (
    <Row title={label}>
      {({ titleId }) => (
        <select aria-labelledby={titleId} className={inp} value={d[key]} onChange={(e) => void savePatch({ permissions: { defaults: { [key]: e.target.value } } })}>
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      )}
    </Row>
  );

  return (
    <>
      <H1>Permissions</H1>
      <Rd>What agents may do without asking. Project rules override these.</Rd>
      <Sec>Defaults</Sec>
      {select('Edit files in its worktree', 'editFiles', [
        ['allow', 'Allow'],
        ['ask', 'Ask'],
      ])}
      {select('Run shell commands', 'shell', [
        ['ask', 'Ask'],
        ['allow', 'Allow'],
      ])}
      {select('Network access', 'network', [
        ['ask', 'Ask'],
        ['allow', 'Allow'],
        ['block', 'Block'],
      ])}

      {projects.length > 0 && (
        <>
          <Row
            title="Rules for"
            desc={
              <>
                Stored in the project's <span className="font-mono">.oide/permissions.json</span>. Untrusted projects ignore their allow rules.
              </>
            }
          >
            {({ titleId, descId }) => (
              <select aria-labelledby={titleId} aria-describedby={descId} className={inp} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Row>
          {rules === null ? (
            <Rd className="mt-3">Loading…</Rd>
          ) : (
            <>
              <RuleList title={`Always allowed in ${project?.name ?? ''}`} rules={rules.allow} onChange={(allow) => void save({ ...rules, allow })} />
              <RuleList title={`Always denied in ${project?.name ?? ''}`} rules={rules.deny} onChange={(deny) => void save({ ...rules, deny })} />
            </>
          )}
        </>
      )}
    </>
  );
}

function RuleList({ title, rules, onChange }: { title: string; rules: string[]; onChange: (r: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const inputId = `rule-${title.replace(/\W+/g, '-')}`;
  const add = () => {
    const v = draft.trim();
    if (!v) return setError('Type a command, for example npm test');
    const rule = toRule(v);
    if (rules.includes(rule)) return setError('That rule is already in the list');
    setError(undefined);
    setDraft('');
    onChange([...rules, rule]);
  };
  return (
    <>
      <Sec>{title}</Sec>
      <ul className="list-none m-0 p-0 flex flex-col gap-1.5 mt-2.5" aria-label={title}>
        {rules.length === 0 && <li className="text-[12.5px] text-ink-3">No rules yet.</li>}
        {rules.map((r) => (
          <li key={r} title={r} className="font-mono flex items-center justify-between px-3 py-2 rounded-md bg-card border border-line-2 text-[12px]">
            {ruleLabel(r)}
            <button
              type="button"
              className="border-0 bg-transparent text-ink-3 hover:text-ink text-[12px] font-sans"
              aria-label={`Remove ${ruleLabel(r)}`}
              onClick={() => onChange(rules.filter((x) => x !== r))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-start gap-2 mt-2">
        <div className="flex flex-col gap-1 flex-1 max-w-[420px]">
          <label htmlFor={inputId} className="sr-only">
            Add a rule to {title}
          </label>
          <input
            id={inputId}
            type="text"
            className={cn(inpSm, 'font-mono h-8', error && inpInvalid)}
            placeholder="npm run lint, or Bash(git status:*)"
            value={draft}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-err` : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          {error && (
            <span id={`${inputId}-err`} className="text-[12px] text-bad">
              {error}
            </span>
          )}
        </div>
        <button type="button" onClick={add} className="h-8 px-3 rounded-md border border-line-3 bg-transparent text-ink text-[12.5px] hover:bg-raised">
          Add rule
        </button>
      </div>
    </>
  );
}
