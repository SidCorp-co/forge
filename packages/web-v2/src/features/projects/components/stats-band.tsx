// Workspace summary row: project count, live runs, open issues, runners, and
// trailing-24h spend — all from `workspaceTotals`.
import { Stat } from '@/design';
import { formatSpend } from '../derive';
import type { WorkspaceTotals } from '../types';
import { ReadFigure } from './read-figure';
import { OPEN_WORK_DEFINITION, OPEN_WORK_LABEL } from '@forge/contracts/work-state';

/** What the Issues figure counts: open work, in the words of the rail's row. */
const OPEN_WORK_COUNTS = `in ${OPEN_WORK_LABEL.toLowerCase()}`;

export interface StatsBandProps {
  totals: WorkspaceTotals;
}

export function StatsBand({ totals }: StatsBandProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-[18px] py-[13px] shadow-sm">
      <span className="text-13-5 font-bold text-fg">Workspace</span>
      <span className="h-4 w-px bg-line" aria-hidden />
      <Stat icon="folder">{totals.projects} projects</Stat>
      <span
        className="inline-flex items-center gap-1.5 font-mono text-12-5 text-accent-text"
        title="Pipeline runs currently running or paused"
      >
        <span className="forge-pulse inline-block size-[7px] rounded-pill bg-accent" aria-hidden />
        <ReadFigure value={totals.liveRuns} read={totals.healthRead} counts="live runs" /> live runs
      </span>
      <Stat icon="inbox" title={`${OPEN_WORK_LABEL}: ${OPEN_WORK_DEFINITION}`}>
        <ReadFigure value={totals.openIssues} read={totals.healthRead} counts={OPEN_WORK_COUNTS} /> {OPEN_WORK_LABEL.toLowerCase()}
      </Stat>
      <Stat icon="server">
        <ReadFigure value={totals.runners} read={totals.healthRead} counts="runners" /> runners
      </Stat>
      <Stat icon="dollar" title="Trailing 24h spend">
        <ReadFigure value={totals.spend24hUsd} read={totals.healthRead} counts="dollars spent in 24h">{formatSpend}</ReadFigure> / 24h
      </Stat>
    </div>
  );
}
