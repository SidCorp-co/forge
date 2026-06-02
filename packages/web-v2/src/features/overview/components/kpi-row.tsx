// The dashboard's top metric strip. Compact, single row that wraps gracefully
// on narrow viewports — each cell is one workspace-wide number with a label and
// a clarifying caption (so "0" never reads as ambiguous). All values come from
// `workspaceKpis` (existing data only).
import { Icon, type IconName } from '@/design';
import { formatCycleTime, formatSpend } from '@/features/projects/derive';
import type { WorkspaceKpis } from '../derive';

interface Cell {
  icon: IconName;
  label: string;
  value: string;
  caption: string;
  /** Render the value in the accent color (live signal). */
  accent?: boolean;
  title?: string;
}

function KpiCell({ cell }: { cell: Cell }) {
  return (
    <div className="flex min-w-[128px] flex-1 items-start gap-2.5 px-3.5 py-3" title={cell.title}>
      <span
        className="mt-0.5 inline-flex size-7 flex-none items-center justify-center rounded-md"
        style={{ background: 'var(--paper-100)' }}
      >
        <Icon name={cell.icon} size={15} className="text-subtle" />
      </span>
      <div className="min-w-0">
        <p
          className="font-mono text-[19px] font-semibold leading-none"
          style={{ color: cell.accent ? 'var(--accent-text)' : 'var(--fg-default)' }}
        >
          {cell.value}
        </p>
        <p className="fg-caption mt-1 truncate font-semibold text-fg">{cell.label}</p>
        <p className="fg-caption truncate text-subtle">{cell.caption}</p>
      </div>
    </div>
  );
}

export function KpiRow({ kpis }: { kpis: WorkspaceKpis }) {
  const cells: Cell[] = [
    { icon: 'folder', label: 'Projects', value: String(kpis.projects), caption: kpis.attentionProjects > 0 ? `${kpis.attentionProjects} need attention` : 'all healthy' },
    { icon: 'pipeline', label: 'Live runs', value: String(kpis.liveRuns), caption: 'running or paused', accent: kpis.liveRuns > 0 },
    { icon: 'inbox', label: 'Active issues', value: String(kpis.openIssues), caption: 'in-flight (not closed)' },
    { icon: 'activity', label: 'Throughput', value: String(kpis.throughput), caption: 'resolved · last 7d' },
    { icon: 'clock', label: 'Avg cycle', value: formatCycleTime(kpis.avgCycleTimeDays), caption: 'created → resolved · 7d', title: 'Mean cycle time over projects with resolved work in the last 7 days' },
    { icon: 'server', label: 'Runners', value: String(kpis.runners), caption: 'online' },
    { icon: 'dollar', label: 'Spend', value: formatSpend(kpis.spend24hUsd), caption: 'trailing 24h' },
  ];

  return (
    <div className="flex flex-wrap divide-x divide-line-subtle overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
      {cells.map((c) => (
        <KpiCell key={c.label} cell={c} />
      ))}
    </div>
  );
}
