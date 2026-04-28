import { TASK_STATUS_COLORS } from '@/lib/colors';
import type { TaskStatus } from '@/features/task/types';
import { ColorBadge } from './color-badge';

const LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const colors = TASK_STATUS_COLORS[status];
  return <ColorBadge label={LABELS[status]} bg={colors.bg} text={colors.text} />;
}
