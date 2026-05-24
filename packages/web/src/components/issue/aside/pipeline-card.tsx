'use client';

import { Lock, LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IssuePipelineActions } from '@/components/issue/issue-detail-modal/issue-pipeline-actions';
import {
  type HoldBadgeState,
  formatHoldCountdown,
} from '@/features/issue/utils/hold-format';
import type { Issue } from '@forge/contracts';

interface PipelineCardProps {
  issue: Issue;
  manualHoldPending: boolean;
  onSetManualHold: (next: boolean) => void;
}

export function PipelineCard({ issue, manualHoldPending, onSetManualHold }: PipelineCardProps) {
  const heldValue = issue.manualHold ?? false;
  // ISS-198 — re-render the badge every 30s so the countdown stays current
  // without polling the server. Cleared when the component unmounts or hold
  // state changes.
  const badge = useHoldBadge(heldValue, issue.manualHoldUntil ?? null);
  return (
    <section className="sticky top-6 rounded-sm border border-outline-variant/20 bg-surface">
      <div className="border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Pipeline
        </h3>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <IssuePipelineActions issueId={issue.id} status={issue.status} />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            Recovery
          </span>
          <span className="font-mono text-xs text-on-surface">{issue.reopenCount ?? 0}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
            Manual hold
          </span>
          <ManualHoldToggle
            value={heldValue}
            badge={badge}
            pending={manualHoldPending}
            onToggle={onSetManualHold}
          />
        </div>
      </div>
    </section>
  );
}

function useHoldBadge(
  manualHold: boolean,
  manualHoldUntil: string | Date | null,
): HoldBadgeState {
  const [state, setState] = useState<HoldBadgeState>(() =>
    formatHoldCountdown(manualHold, manualHoldUntil),
  );
  useEffect(() => {
    setState(formatHoldCountdown(manualHold, manualHoldUntil));
    if (!manualHold || !manualHoldUntil) return;
    const id = setInterval(() => {
      setState(formatHoldCountdown(manualHold, manualHoldUntil));
    }, 30_000);
    return () => clearInterval(id);
  }, [manualHold, manualHoldUntil]);
  return state;
}

function ManualHoldToggle({
  value,
  badge,
  pending,
  onToggle,
}: {
  value: boolean;
  badge: HoldBadgeState;
  pending: boolean;
  onToggle: (next: boolean) => void;
}) {
  const label = badge.kind === 'none' ? (value ? 'Held' : 'Hold') : badge.label;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => onToggle(!value)}
      className={
        value
          ? 'inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/15 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-amber-400 transition-colors hover:bg-amber-500/25 disabled:opacity-50'
          : 'inline-flex items-center gap-1 rounded-sm border border-outline-variant/30 bg-surface-container-high px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant transition-colors hover:bg-surface-container-highest disabled:opacity-50'
      }
      title={value ? 'Manual hold ON — click to release' : 'Click to set manual hold'}
      aria-pressed={value}
    >
      {value ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
      {label}
    </button>
  );
}
