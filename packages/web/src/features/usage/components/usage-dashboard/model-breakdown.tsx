'use client';

import { SectionHeading } from '@/components/ui/section-heading';
import { fmt, fmtCost, pct, modelColor } from './helpers';

export function ModelBreakdown({
  models,
}: {
  models: { model: string; input: number; output: number; cost: number; requests: number }[];
}) {
  const maxCost = models.reduce((m, x) => Math.max(m, x.cost), 0);
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
      <SectionHeading className="mb-0">By Model</SectionHeading>
      <div className="mt-3 space-y-2.5">
        {models.map((m) => {
          const color = modelColor(m.model);
          const w = maxCost > 0 ? Math.max(2, pct(m.cost, maxCost)) : 0;
          return (
            <div key={m.model}>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 text-xs">
                <span className="max-w-[140px] truncate font-medium text-on-surface-variant sm:max-w-[180px]" title={m.model}>
                  {m.model === 'unknown' ? 'unknown' : m.model.replace('claude-', '').replace(/-\d{8}$/, '')}
                </span>
                <div className="flex items-center gap-2 tabular-nums text-outline sm:gap-3">
                  <span className="hidden sm:inline">{fmt(m.input + m.output)} tok</span>
                  <span className="hidden sm:inline">{m.requests} req</span>
                  <span className="font-semibold text-on-surface-variant">{fmtCost(m.cost)}</span>
                </div>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
                <div className="h-full rounded-full" style={{ width: `${w}%`, backgroundColor: color }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
