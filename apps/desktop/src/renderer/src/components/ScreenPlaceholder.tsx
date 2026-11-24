import type { ReactNode } from 'react';
import { Badge, EmptyState, type IconName } from '@oide/ui';

/**
 * PLACEHOLDER chrome for screens that other engineers implement in wave 2. Delete the usage when
 * the real screen lands. `design` names the canvas file in docs/wiki/raw/design/.
 */
export function ScreenPlaceholder({
  title,
  design,
  icon,
  description,
  children,
}: {
  title: string;
  design: string;
  icon: IconName;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="flex-1 min-w-0 overflow-auto flex flex-col gap-3.5 px-5 py-[18px]">
      <div className="flex items-center gap-3">
        <h1 className="m-0 text-[18px] font-semibold tracking-[-0.01em]">{title}</h1>
        <Badge tone="warn">Placeholder</Badge>
      </div>
      {children ?? (
        <EmptyState
          icon={icon}
          title={`${title} is not built yet`}
          description={
            <>
              {description} Design: <span className="font-mono text-ink-2">docs/wiki/raw/design/{design}</span>
            </>
          }
          className="flex-1"
        />
      )}
    </main>
  );
}
