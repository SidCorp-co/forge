import { cn } from '@/lib/utils/cn';
import { STATUS_COLORS, ALL_STATUSES } from '@/lib/constants';
import type { Issue, IssueStatus } from '@/features/issue/types';

interface Props {
  issue: Issue;
  onUpdate: (id: string, data: Partial<Issue>) => void;
}

export function InlineStatusSelect({ issue, onUpdate }: Props) {
  return (
    <select
      value={issue.status}
      onChange={(e) => onUpdate(issue.documentId, { status: e.target.value as IssueStatus })}
      onClick={(e) => e.stopPropagation()}
      className={cn('rounded-sm border-0 px-2 py-1.5 text-xs font-medium cursor-pointer', STATUS_COLORS[issue.status])}
    >
      {ALL_STATUSES.map((s) => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  );
}
