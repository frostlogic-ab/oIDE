/**
 * Settings › Extensions: the `contributes.settings` fields of every installed extension. Plain
 * values save on change (text on blur or Enter); secret ones go to the keychain through main and
 * are never shown again: the field only says whether one is stored, and can replace or clear it.
 */
import { useEffect, useState } from 'react';
import type { ExtensionSettingField, InstalledExtension } from '@oide/protocol';
import { Badge, cn } from '@oide/ui';
import { invokeOr, ipcErrorMessage, oide } from '../lib/bridge';
import { navigate } from '../stores/router';
import { useSettings } from '../stores/settings';
import { toast } from '../stores/ui';
import { H1, Rd, Row, Sec, inp, inpSm, outlineBtn, savePatch } from '../screens/Settings/ui';
import { isOnSomewhere } from './model';
import { useExtensions } from './store';

export function ExtensionSettingsSection() {
  const installed = useExtensions((s) => s.installed);
  const withSettings = installed.filter((e) => Object.keys(e.manifest.oide.contributes.settings).length > 0);
  return (
    <>
      <H1>Extensions</H1>
      <Rd>
        Settings that installed extensions add. Secret values are stored in your system keychain, scoped to
        that extension, and are never shown again. Turn extensions on or off in the{' '}
        <button
          type="button"
          className="p-0 border-0 bg-transparent text-link hover:text-link-hover text-[12.5px]"
          onClick={() => navigate('marketplace', {})}
        >
          Marketplace
        </button>
        .
      </Rd>
      <MarketplaceIndexRow />
      {withSettings.length === 0 && <Rd className="mt-4 block">No installed extension has settings.</Rd>}
      {withSettings.map((e) => (
        <ExtensionFields key={e.id} ext={e} />
      ))}
    </>
  );
}

/**
 * Settings › Extensions › Marketplace index URL (`marketplace.indexUrl`). Empty, the default, means
 * the Marketplace lists only what ships with oIDE and nothing is fetched. A remote https URL needs a
 * native confirmation in main; if it is declined the field goes back to the saved value.
 */
function MarketplaceIndexRow() {
  const value = useSettings((s) => s.settings?.marketplace.indexUrl ?? '');
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    const v = draft.trim();
    if (v === value) return setDraft(v);
    const saved = await savePatch({ marketplace: { indexUrl: v } });
    if (!saved) setDraft(value);
  };
  return (
    <>
      <Sec>Marketplace</Sec>
      <Row
        title="Marketplace index URL"
        desc="Leave empty to use only the extension list built into oIDE (nothing is downloaded). Set an https address to also list the extensions it offers; whoever controls that address decides what you are offered, so oIDE asks you to confirm it."
      >
        {({ titleId, descId }) => (
          <input
            type="url"
            aria-labelledby={titleId}
            aria-describedby={descId}
            className={cn(inpSm, 'w-[320px]')}
            placeholder="Built-in list only"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => e.key === 'Enter' && void commit()}
          />
        )}
      </Row>
    </>
  );
}

function ExtensionFields({ ext }: { ext: InstalledExtension }) {
  const [fields, setFields] = useState<ExtensionSettingField[] | null>(null);
  const [bump, setBump] = useState(0);
  useEffect(
    () => oide.on('extensions.settingChanged', ({ id }) => id === ext.id && setBump((n) => n + 1)),
    [ext.id],
  );
  useEffect(() => {
    let live = true;
    void invokeOr('extensions.settings', { id: ext.id }, [] as ExtensionSettingField[]).then(
      (f) => live && setFields(f),
      (err: unknown) =>
        live &&
        (setFields([]),
        toast(`Could not load ${ext.displayName} settings: ${ipcErrorMessage(err)}`, 'error')),
    );
    return () => {
      live = false;
    };
  }, [ext.id, ext.displayName, bump]);

  const save = async (key: string, value: string | number | boolean | null) => {
    try {
      await oide.invoke('extensions.setSetting', { id: ext.id, key, value });
      setBump((n) => n + 1);
      return true;
    } catch (err) {
      toast(`Could not save ${key}: ${ipcErrorMessage(err)}`, 'error');
      return false;
    }
  };

  return (
    <section aria-label={`${ext.displayName} settings`}>
      <Sec className="flex items-center gap-2">
        <span>{ext.displayName}</span>
        {!isOnSomewhere(ext) && <Badge>Off</Badge>}
      </Sec>
      {fields === null && <Rd className="mt-2 block">Loading…</Rd>}
      {fields?.map((f) => (
        <Row
          key={f.key}
          title={<span className="font-mono text-[12.5px] font-normal">{f.key}</span>}
          desc={f.description ?? (f.secret ? 'Secret' : undefined)}
        >
          {({ titleId, descId }) => (
            <FieldControl
              field={f}
              labelledBy={titleId}
              describedBy={descId}
              onSave={(v) => save(f.key, v)}
            />
          )}
        </Row>
      ))}
    </section>
  );
}

function FieldControl({
  field,
  labelledBy,
  describedBy,
  onSave,
}: {
  field: ExtensionSettingField;
  labelledBy: string;
  describedBy?: string | undefined;
  onSave(v: string | number | boolean | null): Promise<boolean>;
}) {
  const current = field.value ?? field.default;
  const [draft, setDraft] = useState(current === undefined ? '' : String(current));
  useEffect(() => setDraft(current === undefined ? '' : String(current)), [current]);

  if (field.type === 'boolean' && !field.secret) {
    return (
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          className="accent-accent"
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          checked={current === true}
          onChange={(e) => void onSave(e.target.checked)}
        />
        On
      </label>
    );
  }

  if (field.secret) {
    const submit = async () => {
      if (!draft) return;
      if (await onSave(field.type === 'number' ? Number(draft) : draft)) setDraft('');
    };
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {field.hasValue && <Badge tone="ok">Stored in keychain</Badge>}
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          placeholder={field.hasValue ? 'Replace value' : 'Enter value'}
          className={`${inp} w-[220px]`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <button type="button" className={outlineBtn} disabled={!draft} onClick={() => void submit()}>
          Save
        </button>
        {field.hasValue && (
          <button type="button" className={outlineBtn} onClick={() => void onSave(null)}>
            Clear
          </button>
        )}
      </div>
    );
  }

  const commit = () => {
    if (draft === (current === undefined ? '' : String(current))) return;
    if (field.type === 'number') {
      const n = Number(draft);
      if (draft.trim() === '' || !Number.isFinite(n)) {
        toast(`${field.key} must be a number`, 'error');
        setDraft(current === undefined ? '' : String(current));
        return;
      }
      void onSave(n);
    } else void onSave(draft);
  };
  return (
    <input
      type={field.type === 'number' ? 'number' : 'text'}
      spellCheck={false}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`${inp} w-[280px] font-mono text-[12.5px]`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}
