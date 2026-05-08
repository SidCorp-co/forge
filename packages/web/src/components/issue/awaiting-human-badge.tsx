import type { IssueStatus } from '@/features/issue/types';

const NO_SKILL_STATUSES: ReadonlySet<IssueStatus> = new Set(['deploying', 'pass', 'staging']);

export function isAwaitingHumanStatus(status: IssueStatus): boolean {
  return NO_SKILL_STATUSES.has(status);
}

export function AwaitingHumanBadge({ status }: { status: IssueStatus }) {
  if (!isAwaitingHumanStatus(status)) return null;
  const tooltip = `No auto-skill is bound to '${status}' for this project. The pipeline will not advance without manual action or a status override.`;
  return (
    <span
      title={tooltip}
      className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-400"
    >
      <span aria-hidden>⏸</span>
      Awaiting human
    </span>
  );
}
