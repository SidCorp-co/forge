'use client';

import type { ActualUsage } from '../../types-prompt';
import { EmptyState } from './EmptyState';

interface UsageTabProps {
  usage: ActualUsage | null;
}

export function UsageTab({ usage }: UsageTabProps) {
  if (!usage) {
    return (
      <EmptyState
        title="No usage recorded"
        body="Runner did not emit usage_records for this job."
      />
    );
  }

  const cacheHit = usage.cached > usage.cacheCreation;

  return (
    <div className="space-y-3 px-4 py-3 text-xs">
      <div className="flex items-center gap-2">
        <span
          data-testid="cache-pill"
          className={
            cacheHit
              ? 'rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-400'
              : 'rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant'
          }
        >
          {cacheHit ? 'cache hit' : 'cache cold'}
        </span>
        <span className="text-on-surface-variant">
          across {usage.count} call{usage.count === 1 ? '' : 's'}
        </span>
      </div>

      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="border-b border-outline-variant/20 text-left text-on-surface-variant">
            <th className="py-1 pr-2 font-medium">metric</th>
            <th className="py-1 text-right font-medium">value</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-outline-variant/10">
            <td className="py-1 pr-2 text-on-surface">input tokens</td>
            <td className="py-1 text-right font-mono text-on-surface">{usage.input}</td>
          </tr>
          <tr className="border-b border-outline-variant/10">
            <td className="py-1 pr-2 text-on-surface">output tokens</td>
            <td className="py-1 text-right font-mono text-on-surface">{usage.output}</td>
          </tr>
          <tr className="border-b border-outline-variant/10">
            <td className="py-1 pr-2 text-on-surface">cached tokens</td>
            <td className="py-1 text-right font-mono text-on-surface">{usage.cached}</td>
          </tr>
          <tr className="border-b border-outline-variant/10">
            <td className="py-1 pr-2 text-on-surface">cache creation tokens</td>
            <td className="py-1 text-right font-mono text-on-surface">{usage.cacheCreation}</td>
          </tr>
          <tr>
            <td className="py-1 pr-2 font-semibold text-on-surface">cost</td>
            <td className="py-1 text-right font-mono font-semibold text-on-surface">
              ${usage.cost.toFixed(4)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
