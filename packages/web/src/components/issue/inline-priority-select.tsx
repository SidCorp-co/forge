import { cn } from '@/lib/utils/cn';
import { PRIORITY_COLORS, ALL_PRIORITIES } from '@/lib/constants';
import type { Issue, IssuePriority } from '@/features/issue/types';

interface Props {
  issue: Issue;
  onUpdate: (id: string, data: Partial<Issue>) => void;
}

export function InlinePrioritySelect({ issue, onUpdate }: Props) {
  return (
    <select
      value={issue.priority}
      onChange={(e) => onUpdate(issue.documentId, { priority: e.target.value as IssuePriority })}
      onClick={(e) => e.stopPropagation()}
      className={cn('rounded-sm border-0 px-2 py-1.5 text-xs font-medium cursor-pointer', PRIORITY_COLORS[issue.priority])}
    >
      {ALL_PRIORITIES.map((p) => (
        <option key={p.value} value={p.value}>{p.label}</option>
      ))}
    </select>
  );
}
