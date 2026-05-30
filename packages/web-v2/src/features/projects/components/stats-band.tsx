// Workspace summary row: project count, live runs, open issues, runners, and
// trailing-24h spend — all from `workspaceTotals`.
import { Stat } from '@/design';
import { formatSpend } from '../derive';
import type { WorkspaceTotals } from '../types';

export interface StatsBandProps {
  totals: WorkspaceTotals;
}

export function StatsBand({ totals }: StatsBandProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-[18px] py-[13px] shadow-sm">
      <span className="text-[13.5px] font-bold text-fg">Workspace</span>
      <span className="h-4 w-px bg-line" aria-hidden />
      <Stat icon="folder">{totals.projects} projects</Stat>
      <span className="inline-flex items-center gap-1.5 font-mono text-[12.5px] text-accent-text">
        <span className="forge-pulse inline-block size-[7px] rounded-pill bg-accent" aria-hidden />
        {totals.liveRuns} live
      </span>
      <Stat icon="inbox">{totals.openIssues} open</Stat>
      <Stat icon="server">{totals.runners} runners</Stat>
      <Stat icon="dollar" title="Trailing 24h spend">
        {formatSpend(totals.spend24hUsd)} / 24h
      </Stat>
    </div>
  );
}
