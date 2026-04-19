import { cn } from '@/lib/utils/cn';
import { COMPLEXITY_COLORS, ALL_COMPLEXITIES } from '@/lib/constants';
import type { Issue, IssueComplexity } from '@/features/issue/types';

interface Props {
  issue: Issue;
  onUpdate: (id: string, data: Partial<Issue>) => void;
}

export function InlineComplexitySelect({ issue, onUpdate }: Props) {
  return (
    <select
      value={issue.complexity ?? ''}
      onChange={(e) => onUpdate(issue.documentId, { complexity: (e.target.value || null) as IssueComplexity | null })}
      onClick={(e) => e.stopPropagation()}
      className={cn('rounded-sm border-0 px-2 py-1.5 text-xs font-medium cursor-pointer', issue.complexity ? COMPLEXITY_COLORS[issue.complexity] : 'bg-surface-container-low text-primary-fixed')}
    >
      <option value="">-</option>
      {ALL_COMPLEXITIES.map((c) => (
        <option key={c.value} value={c.value}>{c.label}</option>
      ))}
    </select>
  );
}
