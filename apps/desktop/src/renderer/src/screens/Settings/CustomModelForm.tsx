import { useEffect, useRef, useState } from 'react';
import type { CustomModel } from '@oide/protocol';
import { SegmentedControl, cn } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { inp, inpSm, inpInvalid } from './ui';

type Provider = CustomModel['provider'];

export const PROVIDER_LABEL: Record<Provider, string> = {
  local: 'Local',
  'compatible-api': 'Compatible API',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
};

const PROVIDERS: Array<{ value: Provider; url: string; hint: string }> = [
  { value: 'local', url: 'http://localhost:11434', hint: 'A model served on this computer through an Anthropic-compatible endpoint, for example a local gateway.' },
  { value: 'compatible-api', url: 'https://', hint: 'Any hosted endpoint that speaks the Anthropic Messages API, such as a gateway or proxy.' },
  { value: 'bedrock', url: '', hint: 'Claude models through your AWS account. oIDE sets the CLI to use Bedrock.' },
  { value: 'vertex', url: '', hint: 'Claude models through your Google Cloud project. oIDE sets the CLI to use Vertex AI.' },
];

const regionKey = (p: Provider) => (p === 'bedrock' ? 'AWS_REGION' : 'CLOUD_ML_REGION');

/**
 * "Add a model" form. The API key lives only in this component's state until Save; right after
 * `settings.saveCustomModel` the state is cleared and the form closes, so the key is never shown
 * again (the card says "Key stored").
 */
export function CustomModelForm({ editing, onClose }: { editing?: CustomModel; onClose: () => void }) {
  const [provider, setProvider] = useState<Provider>(editing?.provider ?? 'local');
  const [name, setName] = useState(editing?.name ?? '');
  const [modelId, setModelId] = useState(editing?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? PROVIDERS[0]!.url);
  const [region, setRegion] = useState(editing ? (editing.extraEnv[regionKey(editing.provider)] ?? '') : '');
  const [apiKey, setApiKey] = useState('');
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);

  const cloud = provider === 'bedrock' || provider === 'vertex';
  const errors = {
    name: !name.trim() ? 'Give the model a name' : !/^[\w .-]+$/.test(name.trim()) ? 'Use letters, numbers, spaces, dots, dashes' : undefined,
    model: !modelId.trim() ? 'Enter the model ID the endpoint expects' : undefined,
    url: cloud ? undefined : !/^https?:\/\/[^\s/]+/.test(baseUrl.trim()) ? 'Enter an http(s) URL' : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);

  const pick = (p: Provider) => {
    setProvider(p);
    if (!editing) setBaseUrl(PROVIDERS.find((x) => x.value === p)!.url);
  };

  const save = async () => {
    setTried(true);
    if (invalid) return;
    setSaving(true);
    const model: CustomModel = {
      id: editing?.id ?? `model-${Date.now().toString(36)}`,
      name: name.trim(),
      provider,
      baseUrl: cloud ? undefined : baseUrl.trim(),
      model: modelId.trim(),
      hasKey: editing?.hasKey ?? false,
      extraEnv: cloud && region.trim() ? { ...(editing?.extraEnv ?? {}), [regionKey(provider)]: region.trim() } : (editing?.extraEnv ?? {}),
    };
    const key = apiKey;
    setApiKey(''); // never keep the secret in React state past this point
    try {
      await oide.invoke('settings.saveCustomModel', key ? { model, apiKey: key } : { model });
      toast(key ? `${model.name} saved. Key stored in your keychain.` : `${model.name} saved.`, 'success');
      onClose();
    } catch (err) {
      toast(`Could not save ${model.name}: ${ipcErrorMessage(err)}`, 'error');
      setSaving(false);
    }
  };

  const field = 'flex flex-col gap-1.5 text-[12px] text-ink-2';
  const err = (id: string, msg?: string) =>
    tried && msg ? (
      <span id={id} className="text-[11.5px] text-bad">
        {msg}
      </span>
    ) : null;

  return (
    <form
      aria-label={editing ? `Edit ${editing.name}` : 'Add a model'}
      className="flex flex-col gap-3 mt-2.5 p-4 rounded-xl border border-accent bg-panel"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <span className="font-semibold">{editing ? `Edit ${editing.name}` : 'Add a model'}</span>
      <SegmentedControl
        className="self-start flex-wrap"
        label="Provider"
        variant="inset"
        size={28}
        value={provider}
        onChange={pick}
        options={PROVIDERS.map((p) => ({ value: p.value, label: PROVIDER_LABEL[p.value] }))}
      />
      <span className="text-[12.5px] text-ink-3 leading-[1.45]">{PROVIDERS.find((p) => p.value === provider)!.hint}</span>
      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <label htmlFor="cm-name">Display name</label>
          <input
            id="cm-name"
            ref={first}
            type="text"
            className={cn(inp, tried && errors.name && inpInvalid)}
            value={name}
            placeholder="local-coder"
            aria-invalid={tried && errors.name ? true : undefined}
            aria-describedby={tried && errors.name ? 'cm-name-err' : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          {err('cm-name-err', errors.name)}
        </div>
        <div className={field}>
          <label htmlFor="cm-model">Model ID</label>
          <input
            id="cm-model"
            type="text"
            className={cn(inpSm, 'font-mono', tried && errors.model && inpInvalid)}
            value={modelId}
            placeholder={provider === 'local' ? 'qwen3-coder:30b' : 'model id'}
            aria-invalid={tried && errors.model ? true : undefined}
            aria-describedby={tried && errors.model ? 'cm-model-err' : undefined}
            onChange={(e) => setModelId(e.target.value)}
          />
          {err('cm-model-err', errors.model)}
        </div>
        {cloud ? (
          <div className={field}>
            <label htmlFor="cm-region">Region</label>
            <input
              id="cm-region"
              type="text"
              className={cn(inpSm, 'font-mono')}
              value={region}
              placeholder={provider === 'bedrock' ? 'us-east-1 (uses AWS credentials)' : 'us-east5 (uses Google Cloud credentials)'}
              onChange={(e) => setRegion(e.target.value)}
            />
          </div>
        ) : (
          <div className={field}>
            <label htmlFor="cm-url">Base URL</label>
            <input
              id="cm-url"
              type="text"
              className={cn(inpSm, 'font-mono', tried && errors.url && inpInvalid)}
              value={baseUrl}
              aria-invalid={tried && errors.url ? true : undefined}
              aria-describedby={tried && errors.url ? 'cm-url-err' : undefined}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {err('cm-url-err', errors.url)}
          </div>
        )}
        <div className={field}>
          <label htmlFor="cm-key">API key or token</label>
          <input
            id="cm-key"
            type="password"
            autoComplete="off"
            className={inp}
            value={apiKey}
            placeholder={editing?.hasKey ? 'Key stored · leave empty to keep it' : 'Stored in your OS keychain'}
            aria-describedby="cm-key-hint"
            onChange={(e) => setApiKey(e.target.value)}
          />
          <span id="cm-key-hint" className="text-[11.5px] text-ink-3">
            Saved to your OS keychain and never shown again.
          </span>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-8 px-3 rounded-md border border-line-3 bg-transparent text-ink text-[12.5px] hover:bg-raised">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="h-8 px-3.5 rounded-md border-0 bg-accent text-on-accent font-semibold text-[12.5px] disabled:opacity-50">
          {editing ? 'Save model' : 'Add model'}
        </button>
      </div>
    </form>
  );
}
