import type { Issue, IssuePatchInput } from '@forge/contracts';
import { cn } from '@/lib/utils/cn';
import { PRIORITY_COLORS, ALL_PRIORITIES } from '@/lib/constants';
import type { IssuePriority } from '@/features/issue/types';

interface Props {
  issue: Issue;
  onUpdate: (id: string, data: IssuePatchInput) => void;
}

export function InlinePrioritySelect({ issue, onUpdate }: Props) {
  const priority = (issue.priority ?? 'none') as IssuePriority;
  return (
    <select
      value={priority}
      onChange={(e) => onUpdate(issue.id, { priority: e.target.value as IssuePriority })}
      onClick={(e) => e.stopPropagation()}
      className={cn('rounded-sm border-0 px-2 py-1.5 text-xs font-medium cursor-pointer', PRIORITY_COLORS[priority])}
    >
      {ALL_PRIORITIES.map((p) => (
        <option key={p.value} value={p.value}>{p.label}</option>
      ))}
    </select>
  );
}
