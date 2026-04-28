import { useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getTasks, getIssues, updateTask, updateIssue } from "@/lib/api";
import { useOptimisticMutation } from "@/hooks/use-optimistic-mutation";
import type { Task, Issue, IssueStatus, KanbanColumn as KanbanCol } from "@/lib/types";
import { Skeleton, ToastContainer } from "@/components/ui";
import { DropColumn } from "@/components/board/drop-column";
import { DraggableIssueCard } from "@/components/board/draggable-issue-card";
import { DraggableTaskCard } from "@/components/board/draggable-task-card";
import { useToast } from "@/hooks/use-toast";
import { useChangedIds } from "@/hooks/use-changed-ids";
import { BoardToolbar } from "./board-toolbar";
import { ALL_ISSUE_COLS, TASK_COLS, DEFAULT_VISIBLE } from "./constants";

export function ProjectBoard() {
  const { slug } = useParams<{ slug: string }>();
  const [viewMode, setViewMode] = useState<"issues" | "tasks">("issues");

  const { data: tasks = [], isLoading: loadingTasks } = useQuery({
    queryKey: ["tasks", slug],
    queryFn: () => getTasks(slug!),
    enabled: !!slug,
    refetchInterval: 10000,
  });

  const { data: issues = [], isLoading: loadingIssues } = useQuery({
    queryKey: ["issues", slug],
    queryFn: () => getIssues(slug!),
    enabled: !!slug,
    refetchInterval: 10000,
  });

  const isLoading = loadingTasks || loadingIssues;

  const changedIssueIds = useChangedIds(issues);
  const changedTaskIds = useChangedIds(tasks);
  const { toasts, addToast } = useToast();

  const [visibleCols, setVisibleCols] = useState<Record<IssueStatus, boolean>>(DEFAULT_VISIBLE);
  const [showColPicker, setShowColPicker] = useState(false);
  const toggleCol = (status: IssueStatus) => {
    setVisibleCols((prev) => ({ ...prev, [status]: !prev[status] }));
  };

  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const assignees = Array.from(new Set(tasks.map((t) => t.assignee).filter(Boolean))) as string[];
  const filteredTasks = tasks.filter((t) => {
    if (assigneeFilter !== "all" && t.assignee !== assigneeFilter) return false;
    if (agentFilter !== "all" && t.agentStatus !== agentFilter) return false;
    return true;
  });

  const moveIssueMutation = useOptimisticMutation<Issue, { documentId: string; status: IssueStatus }>({
    queryKey: ["issues", slug],
    mutationFn: ({ documentId, status }) => updateIssue(documentId, { status }),
    updateData: (old, { documentId, status }) => old?.map((i) => (i.documentId === documentId ? { ...i, status } : i)),
    onError: () => addToast("Failed to update issue"),
  });

  const moveTaskMutation = useOptimisticMutation<Task, { documentId: string; status: KanbanCol }>({
    queryKey: ["tasks", slug],
    mutationFn: ({ documentId, status }) => updateTask(documentId, { status }),
    updateData: (old, { documentId, status }) => old?.map((t) => (t.documentId === documentId ? { ...t, status } : t)),
    onError: () => addToast("Failed to update task"),
  });

  const handleIssueDrop = useCallback(
    (issueId: string, status: string) => {
      moveIssueMutation.mutate({ documentId: issueId, status: status as IssueStatus });
    },
    [moveIssueMutation],
  );

  const handleTaskDrop = useCallback(
    (taskId: string, status: string) => {
      moveTaskMutation.mutate({ documentId: taskId, status: status as KanbanCol });
    },
    [moveTaskMutation],
  );

  const activeCols = ALL_ISSUE_COLS.filter((c) => visibleCols[c.status]);

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="mb-4 flex items-center gap-3">
          <Skeleton className="h-10 w-48 rounded-lg" />
        </div>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="w-64 shrink-0 space-y-3">
              <Skeleton className="h-8 w-full rounded-lg" />
              {[1, 2, 3].map((j) => <Skeleton key={j} className="h-24 w-full rounded-lg" />)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <BoardToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        visibleCols={visibleCols}
        showColPicker={showColPicker}
        onToggleColPicker={() => setShowColPicker(!showColPicker)}
        onCloseColPicker={() => setShowColPicker(false)}
        onToggleCol={toggleCol}
        assigneeFilter={assigneeFilter}
        onAssigneeFilterChange={setAssigneeFilter}
        agentFilter={agentFilter}
        onAgentFilterChange={setAgentFilter}
        assignees={assignees}
      />

      {viewMode === "issues" && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {activeCols.map((col) => {
            const colIssues = issues.filter((i) => i.status === col.status);
            return (
              <DropColumn key={col.status} label={col.label} color={col.color} bg={col.bg} count={colIssues.length} status={col.status} onDrop={handleIssueDrop} dragType="issueId">
                {colIssues.map((issue) => (
                  <DraggableIssueCard key={issue.id} issue={issue} highlight={changedIssueIds.has(issue.documentId)} />
                ))}
                {colIssues.length === 0 && <p className="py-8 text-center text-xs text-gray-400">No issues</p>}
              </DropColumn>
            );
          })}
        </div>
      )}

      {viewMode === "tasks" && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {TASK_COLS.map((col) => {
            const colTasks = filteredTasks.filter((t) => t.status === col.status);
            return (
              <DropColumn key={col.status} label={col.label} color={col.color} bg={col.bg} count={colTasks.length} status={col.status} onDrop={handleTaskDrop} dragType="taskId">
                {colTasks.map((task) => (
                  <DraggableTaskCard key={task.id} task={task} highlight={changedTaskIds.has(task.documentId)} />
                ))}
                {colTasks.length === 0 && <p className="py-8 text-center text-xs text-gray-400">No tasks</p>}
              </DropColumn>
            );
          })}
        </div>
      )}

      <ToastContainer toasts={toasts} />
    </div>
  );
}
