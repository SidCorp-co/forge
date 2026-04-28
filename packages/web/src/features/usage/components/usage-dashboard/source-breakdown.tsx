'use client';

import { SectionHeading } from '@/components/ui/section-heading';
import { fmt, fmtCost, pct } from './helpers';

export function SourceBreakdown({
  sources,
}: {
  sources: { source: string; input: number; output: number; cost: number; requests: number }[];
}) {
  const total = sources.reduce((s, x) => s + x.input + x.output, 0);
  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
      <SectionHeading className="mb-0">By Source</SectionHeading>
      <div className="mt-3 space-y-3">
        {sources.map((s) => {
          const tokens = s.input + s.output;
          return (
            <div key={s.source} className="flex items-center gap-2 sm:gap-3">
              <span className="w-12 shrink-0 text-xs font-medium capitalize text-on-surface-variant sm:w-14">{s.source}</span>
              <div className="flex h-6 flex-1 overflow-hidden rounded bg-surface-container-high">
                <div className="h-full bg-info" style={{ width: `${pct(s.input, total)}%` }} title={`Input: ${fmt(s.input)}`} />
                <div className="h-full bg-info" style={{ width: `${pct(s.output, total)}%` }} title={`Output: ${fmt(s.output)}`} />
              </div>
              <div className="flex flex-col items-end text-[11px] tabular-nums">
                <span className="font-medium text-on-surface-variant">{fmt(tokens)}</span>
                <span className="text-outline">{fmtCost(s.cost)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
