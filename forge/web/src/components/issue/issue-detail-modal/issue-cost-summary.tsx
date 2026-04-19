'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, DollarSign } from 'lucide-react';
import { useIssueCost } from '@/features/issue/hooks/use-issue-cost';


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function prettifyStep(skill: string): string {
  return skill
    .replace(/^forge-/, '')
    .replace(/-/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function IssueCostSummary({ documentId }: { documentId: string }) {
  const { data, isLoading } = useIssueCost(documentId);
  const [expanded, setExpanded] = useState(false);

  if (isLoading || !data || data.sessionCount === 0) return null;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-primary-fixed">
          Cost Summary
        </h4>
        <span className="flex items-center gap-1 font-mono text-sm font-bold text-on-surface">
          <DollarSign className="h-3.5 w-3.5 text-primary-fixed" />
          {data.totalCost.toFixed(2)}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="font-mono text-xs font-medium text-on-surface">
            {formatTokens(data.totalOutputTokens)}
          </div>
          <div className="text-[9px] text-on-surface-variant uppercase tracking-widest">Output</div>
        </div>
        <div>
          <div className="font-mono text-xs font-medium text-on-surface">
            {formatTokens(data.totalCacheReadTokens)}
          </div>
          <div className="text-[9px] text-on-surface-variant uppercase tracking-widest">Cache</div>
        </div>
        <div>
          <div className="font-mono text-xs font-medium text-on-surface">{data.totalTurns}</div>
          <div className="text-[9px] text-on-surface-variant uppercase tracking-widest">Turns</div>
        </div>
        <div>
          <div className="font-mono text-xs font-medium text-on-surface">{data.sessionCount}</div>
          <div className="text-[9px] text-on-surface-variant uppercase tracking-widest">Sessions</div>
        </div>
      </div>

      {data.byStep.length > 0 && (
        <div className="space-y-1">
          {data.byStep.map((s) => (
            <div
              key={s.step}
              className="flex items-center justify-between rounded-sm bg-surface-container-low px-3 py-1.5"
            >
              <span className="text-[10px] font-medium uppercase tracking-widest text-on-surface-variant">
                {prettifyStep(s.step)}
              </span>
              <div className="flex items-center gap-3 font-mono text-[10px]">
                <span className="text-on-surface-variant">
                  {formatTokens(s.inputTokens + s.outputTokens)}
                </span>
                <span className="font-medium text-on-surface">${s.cost.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {data.sessions.length > 1 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-primary-fixed hover:text-on-surface transition-colors"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Session details
          </button>
          {expanded && (
            <div className="mt-2 space-y-1">
              {data.sessions.map((s) => (
                <div
                  key={s.documentId}
                  className="flex items-center justify-between rounded-sm border border-outline-variant/20 px-3 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[10px] font-mono text-on-surface">{s.title}</div>
                    <div className="text-[9px] text-on-surface-variant">{s.model}</div>
                  </div>
                  <span className="shrink-0 font-mono text-[10px] font-medium text-on-surface ml-2">
                    ${s.cost.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
