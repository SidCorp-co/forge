import type { Issue } from "@/lib/types";
import { StatusBadge } from "../ui/status-badge";

interface Props {
  issue: Issue;
}

export function IssueTasks({ issue }: Props) {
  const totalTasks = issue.tasks?.length ?? 0;
  if (totalTasks === 0) return null;

  const doneTasks = issue.tasks?.filter((t) => t.status === "done").length ?? 0;
  const progress = Math.round((doneTasks / totalTasks) * 100);

  return (
    <div className="px-6 py-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Tasks</h3>
        <span className="text-xs text-gray-500">{doneTasks}/{totalTasks}</span>
      </div>
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-gray-200">
        <div className="h-full rounded-full bg-green-500 transition-all" style={{ width: `${progress}%` }} />
      </div>
      <ul className="space-y-1">
        {issue.tasks?.map((task) => (
          <li key={task.id} className="flex items-center gap-2 text-sm">
            <StatusBadge status={task.status} />
            <span className={task.status === "done" ? "text-gray-400 line-through" : "text-gray-700"}>{task.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
