import { useState } from "react";
import clsx from "clsx";
import type { Task } from "@/lib/types";
import { AgentRunningDot } from "@/components/ui/agent-running-dot";
import { PriorityBadge } from "@/components/ui/priority-badge";

export function DraggableTaskCard({ task, highlight }: { task: Task; highlight?: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("taskId", task.documentId); }}
      className={clsx(
        "cursor-grab rounded-lg border bg-white p-3 shadow-sm transition-all hover:shadow-md active:cursor-grabbing",
        highlight && "ring-2 ring-blue-400 animate-highlight-fade",
      )}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-tight text-gray-900">{task.title}</p>
        {task.isAgentTask && task.agentStatus && task.agentStatus !== "idle" && task.agentStatus === "running" && (
          <span className="shrink-0">
            <AgentRunningDot size="md" color="blue" />
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.priority && task.priority !== "none" && (
          <PriorityBadge priority={task.priority} />
        )}
        {task.isAgentTask && (
          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">agent</span>
        )}
        {task.assignee && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{task.assignee}</span>
        )}
      </div>
      {expanded && (
        <div className="mt-3 space-y-2 border-t border-gray-100 pt-2 text-xs text-gray-600">
          {task.description && <p>{task.description}</p>}
          {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
            <div>
              <span className="font-medium text-gray-700">Acceptance criteria:</span>
              <ul className="mt-0.5 list-inside list-disc">
                {task.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
          {task.agentStatus === "running" && (
            <div className="flex items-center gap-1.5 text-blue-600">
              <AgentRunningDot size="sm" color="blue" />
              Agent running...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
