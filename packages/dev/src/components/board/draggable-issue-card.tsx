import clsx from "clsx";
import type { Issue } from "@/lib/types";
import { AgentRunningDot } from "@/components/ui/agent-running-dot";
import { PriorityBadge } from "@/components/ui/priority-badge";

export function DraggableIssueCard({ issue, highlight }: { issue: Issue; highlight?: boolean }) {
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("issueId", issue.documentId); }}
      className={clsx(
        "cursor-grab rounded-lg border bg-white p-3 shadow-sm transition-all hover:shadow-md active:cursor-grabbing",
        highlight && "ring-2 ring-blue-400 animate-highlight-fade",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-tight text-gray-900">
          <span className="mr-1 font-mono text-[10px] text-gray-400">ISS-{issue.id}</span>
          {issue.title}
        </p>
        {issue.agentStatus && issue.agentStatus !== "idle" && (
          <span className="shrink-0">
            {issue.agentStatus === "running" && <AgentRunningDot size="md" color="blue" />}
            {issue.agentStatus === "completed" && <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />}
            {issue.agentStatus === "failed" && <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {issue.priority && issue.priority !== "none" && (
          <PriorityBadge priority={issue.priority} />
        )}
      </div>
    </div>
  );
}
