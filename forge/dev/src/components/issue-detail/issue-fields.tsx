import type { Issue } from "@/lib/types";
import { StatusBadge } from "../ui/status-badge";
import { InlineStatusSelect } from "../issue/inline-status-select";
import { InlinePrioritySelect } from "../issue/inline-priority-select";

interface Props {
  issue: Issue;
  onUpdate: (id: string, data: Partial<Issue>) => void;
}

export function IssueFields({ issue, onUpdate }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-4 px-6 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Status</span>
        <InlineStatusSelect issue={issue} onUpdate={onUpdate} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-500">Priority</span>
        <InlinePrioritySelect issue={issue} onUpdate={onUpdate} />
      </div>
      {issue.category && (
        <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700">{issue.category}</span>
      )}
      {issue.agentStatus && (
        <StatusBadge status={issue.agentStatus} />
      )}
    </div>
  );
}
