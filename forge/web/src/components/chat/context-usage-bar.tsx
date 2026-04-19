'use client';

import { CONTEXT_LIMIT } from '@/lib/utils/format-tokens';
import type { AgentUsage } from '@/features/agent/api';

interface ContextUsageBarProps {
  usage: AgentUsage;
}

export function ContextUsageBar({ usage }: ContextUsageBarProps) {
  if (usage.turns === 0) return null;

  const pct = Math.min(100, Math.round((usage.contextUsed / CONTEXT_LIMIT) * 100));
  const remaining = Math.max(0, 100 - pct);
  // Red at 60% used (600K — non-resumable), yellow at 39% (390K — context save)
  const barColor = pct >= 60 ? 'bg-danger' : pct >= 39 ? 'bg-warning-dim/100' : 'bg-success';

  return (
    <span className="flex items-center gap-1.5 text-[10px] text-[#555555] ml-2 shrink-0">
      <span className="w-10 sm:w-16 h-1.5 rounded-full bg-[#333333] inline-block relative">
        <span className={`absolute inset-y-0 left-0 rounded-full ${barColor}`} style={{ width: `${remaining}%` }} />
      </span>
      <span className={pct >= 60 ? 'text-danger' : ''}>{remaining}%</span>
    </span>
  );
}
