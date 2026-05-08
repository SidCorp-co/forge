import type { Issue } from '@forge/contracts';
import { cn } from '@/lib/utils/cn';
import { STATUS_COLORS, ALL_STATUSES } from '@/lib/constants';
import type { IssueStatus } from '@/features/issue/types';
import { AwaitingHumanBadge } from './awaiting-human-badge';

interface Props {
  issue: Issue;
  // status is owned by the F4 transition endpoint, not the generic PATCH;
  // the caller decides how to route the update.
  onUpdate: (id: string, data: { status: IssueStatus }) => void;
}

export function InlineStatusSelect({ issue, onUpdate }: Props) {
  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={issue.status}
        onChange={(e) => onUpdate(issue.id, { status: e.target.value as IssueStatus })}
        onClick={(e) => e.stopPropagation()}
        className={cn('rounded-sm border-0 px-2 py-1.5 text-xs font-medium cursor-pointer', STATUS_COLORS[issue.status])}
      >
        {ALL_STATUSES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
      <AwaitingHumanBadge status={issue.status} />
    </span>
  );
}
