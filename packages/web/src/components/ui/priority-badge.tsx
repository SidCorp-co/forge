import { cn } from '@/lib/utils/cn';
import { PRIORITY_COLORS } from '@/lib/constants';
import type { IssuePriority } from '@/features/issue/types';

export function PriorityBadge({ priority }: { priority: IssuePriority }) {
  return (
    <span className={cn('rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider', PRIORITY_COLORS[priority])}>
      {priority}
    </span>
  );
}
