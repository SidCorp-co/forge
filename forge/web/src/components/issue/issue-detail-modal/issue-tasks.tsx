'use client';

import { cn } from '@/lib/utils/cn';
import { TASK_STATUS_COLORS } from '@/lib/constants';

interface Task {
  id: number;
  title: string;
  status: string;
}

interface IssueTasksProps {
  tasks: Task[];
}

export function IssueTasks({ tasks }: IssueTasksProps) {
  if (tasks.length === 0) return null;

  const doneTasks = tasks.filter((t) => t.status === 'done').length;
  const progress = Math.round((doneTasks / tasks.length) * 100);

  return (
    <div className="p-4 space-y-4">
      <div className="h-1 w-full overflow-hidden bg-surface-container-low">
        <div className="h-full bg-success transition-all" style={{ width: `${progress}%` }} />
      </div>
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-3 text-xs font-mono uppercase tracking-widest text-tertiary">
            <span className={cn('rounded-sm border px-2 py-0.5 text-[10px] font-bold tracking-widest', task.status === 'done' ? 'border-success/30 bg-success-surface text-success' : 'border-outline-variant/50 bg-surface-container-low text-on-surface-variant')}>
              {task.status}
            </span>
            <span className={task.status === 'done' ? 'text-outline-variant line-through' : ''}>{task.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
