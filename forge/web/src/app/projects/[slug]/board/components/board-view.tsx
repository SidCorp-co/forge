'use client';

import { Skeleton } from '@/components/ui';
import { IssueDetailModal } from '@/components/issue/issue-detail-modal';
import { ToastContainer } from '@/components/ui/toast-container';
import { ALL_ISSUE_COLS, TASK_COLS } from '../constants';
import { BoardToolbar } from './board-toolbar';
import { DropColumn } from './drop-column';
import { DraggableIssueCard } from './draggable-issue-card';
import { DraggableTaskCard } from './draggable-task-card';
import type { useBoard } from '../hooks/use-board';

type BoardState = ReturnType<typeof useBoard>;

export function BoardView(props: BoardState) {
  const {
    viewMode, setViewMode, loading,
    issues, selectedIssueId, setSelectedIssueId, changedIssueIds,
    visibleCols, showColPicker, setShowColPicker, toggleCol, handleIssueDrop,
    filteredTasks, changedTaskIds,
    assignees, assigneeFilter, setAssigneeFilter, agentFilter, setAgentFilter,
    handleTaskDrop, toasts,
  } = props;

  const activeCols = ALL_ISSUE_COLS.filter((c) => visibleCols[c.status]);

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-64 min-w-[200px] flex-1" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <BoardToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        visibleCols={visibleCols}
        showColPicker={showColPicker}
        onToggleColPicker={() => setShowColPicker(!showColPicker)}
        onCloseColPicker={() => setShowColPicker(false)}
        onToggleCol={toggleCol}
        assignees={assignees}
        assigneeFilter={assigneeFilter}
        onAssigneeFilterChange={setAssigneeFilter}
        agentFilter={agentFilter}
        onAgentFilterChange={setAgentFilter}
      />

      {viewMode === 'issues' && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {activeCols.map((col) => {
            const colIssues = issues.filter((i: { status: string }) => i.status === col.status);
            return (
              <DropColumn
                key={col.status}
                label={col.label}
                color={col.color}
                bg={col.bg}
                count={colIssues.length}
                status={col.status}
                onDrop={handleIssueDrop}
                dragType="issueId"
              >
                {colIssues.map((issue: { id: string }) => (
                  <DraggableIssueCard
                    key={issue.id}
                    issue={issue as never}
                    onSelect={setSelectedIssueId}
                    highlight={changedIssueIds.has(issue.id)}
                  />
                ))}
                {colIssues.length === 0 && (
                  <p className="py-8 text-center text-xs text-outline">No issues</p>
                )}
              </DropColumn>
            );
          })}
        </div>
      )}

      {viewMode === 'tasks' && (
        <p className="py-8 text-center text-xs text-outline">
          Tasks view is not available on forge/core yet.
        </p>
      )}

      {selectedIssueId && (
        <IssueDetailModal issueId={selectedIssueId} onClose={() => setSelectedIssueId(null)} />
      )}

      <ToastContainer toasts={toasts} />
    </div>
  );
}
