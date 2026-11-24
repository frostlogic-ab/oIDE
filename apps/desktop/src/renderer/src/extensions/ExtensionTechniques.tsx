import type { Technique } from '@oide/protocol';
import { Rd } from '../screens/Settings/ui';

/**
 * Settings › Techniques: techniques extensions contribute (`contributes.techniques`). They are off
 * by default, show up in Spawn agent like the others, and change only with the extension.
 */
export function ExtensionTechniques({ list }: { list: readonly Technique[] }) {
  if (!list.length) return null;
  return (
    <section aria-label="Techniques from extensions" className="mt-[22px] flex flex-col gap-2">
      <h2 className="m-0 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">
        From extensions · {list.length}
      </h2>
      <Rd>
        Added by extensions that are on. Switch them on per agent in Spawn agent; to change one, change or
        turn off its extension.
      </Rd>
      <ul className="list-none m-0 p-0 flex flex-col gap-2">
        {list.map((t) => (
          <li
            key={t.id}
            className="flex flex-col gap-1.5 px-3.5 py-3 rounded-xl border border-line-2 bg-panel"
          >
            <span className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{t.name}</span>
              <span className="text-[11px] px-[7px] py-px rounded-[9px] border border-line-3 text-ink-3">
                {t.extension}
              </span>
              <span className="text-[11.5px] text-ink-3">
                {t.placement === 'system-prompt' ? 'System prompt' : 'First message'}
              </span>
            </span>
            <span className="font-mono text-[12px] leading-[1.55] text-ink-2 whitespace-pre-wrap">
              {t.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
