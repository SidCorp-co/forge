import type { Issue, IssuePatchInput } from '@forge/contracts';
import { cn } from '@/lib/utils/cn';
import { COMPLEXITY_COLORS, ALL_COMPLEXITIES } from '@/lib/constants';
import type { IssueComplexity } from '@/features/issue/types';

interface Props {
  issue: Issue;
  onUpdate: (id: string, data: IssuePatchInput) => void;
}

export function InlineComplexitySelect({ issue, onUpdate }: Props) {
  const value = (issue.complexity ?? '') as IssueComplexity | '';
  return (
    <select
      value={value}
      onChange={(e) =>
        onUpdate(issue.id, {
          complexity: e.target.value === '' ? null : (e.target.value as IssueComplexity),
        })
      }
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'rounded-sm border-0 px-2 py-1.5 text-xs font-medium cursor-pointer',
        value ? COMPLEXITY_COLORS[value as IssueComplexity] : 'bg-surface-container-low text-primary-fixed',
      )}
    >
      <option value="">-</option>
      {ALL_COMPLEXITIES.map((c) => (
        <option key={c.value} value={c.value}>{c.label}</option>
      ))}
    </select>
  );
}
