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
import type { IssueStatus } from '@/features/issue/types';

type BoardState = ReturnType<typeof useBoard>;

export function BoardView(props: BoardState) {
  const {
    slug,
    viewMode, setViewMode, loading,
    selectedIssueId, setSelectedIssueId, changedIssueIds,
    visibleCols, showColPicker, setShowColPicker, toggleCol,
    handleIssueDropCell,
    groupedIssues, groupByRow, setGroupByRow,
    density, setDensity,
    collapsedCols, toggleCollapsedCol,
    wipLimits, setWipLimit,
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
      <div className="sticky top-0 z-20 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/70">
        <BoardToolbar
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          visibleCols={visibleCols}
          showColPicker={showColPicker}
          onToggleColPicker={() => setShowColPicker(!showColPicker)}
          onCloseColPicker={() => setShowColPicker(false)}
          onToggleCol={toggleCol}
          density={density}
          onDensityChange={setDensity}
          groupByRow={groupByRow}
          onGroupByRowChange={setGroupByRow}
          assignees={assignees}
          assigneeFilter={assigneeFilter}
          onAssigneeFilterChange={setAssigneeFilter}
          agentFilter={agentFilter}
          onAgentFilterChange={setAgentFilter}
        />
      </div>

      {viewMode === 'issues' && (
        <div className="overflow-x-auto pb-4">
          <div className="flex flex-col gap-4">
            {groupedIssues.map(({ rowKey, rowLabel, issues: rowIssues }) => (
              <div
                key={rowKey}
                className="flex gap-3 snap-x snap-mandatory sm:snap-none"
              >
                {groupByRow !== 'none' && (
                  <div className="sticky left-0 z-10 flex w-32 shrink-0 items-start pt-3 text-sm font-medium text-on-surface-variant">
                    {rowLabel}
                  </div>
                )}
                {activeCols.map((col) => {
                  const cellIssues = rowIssues.filter((i) => i.status === col.status);
                  const wipLimit = wipLimits[col.status] ?? null;
                  const wipCurrent =
                    wipLimit != null
                      ? // WIP measured across all rows in this column, not the
                        // cell — limits apply to total status load.
                        groupedIssues.reduce(
                          (acc, g) => acc + g.issues.filter((i) => i.status === col.status).length,
                          0,
                        )
                      : undefined;
                  const collapsed = !!collapsedCols[col.status];
                  return (
                    <div
                      key={col.status}
                      className="flex min-w-[260px] flex-1 snap-start sm:min-w-[180px]"
                    >
                      <DropColumn
                        label={col.label}
                        color={col.color}
                        bg={col.bg}
                        count={cellIssues.length}
                        status={col.status}
                        onDrop={(itemId, status) => handleIssueDropCell(itemId, status, rowKey)}
                        dragType="issueId"
                        wipCurrent={wipCurrent}
                        wipLimit={wipLimit}
                        collapsed={collapsed}
                        onToggleCollapsed={() => toggleCollapsedCol(col.status)}
                        onEditWipLimit={(s: IssueStatus, v) => setWipLimit(s, v)}
                      >
                        {!collapsed && cellIssues.map((issue) => (
                          <DraggableIssueCard
                            key={issue.id}
                            issue={issue as never}
                            onSelect={setSelectedIssueId}
                            highlight={changedIssueIds.has(issue.id)}
                            density={density}
                          />
                        ))}
                        {!collapsed && cellIssues.length === 0 && (
                          <p className="py-8 text-center text-xs text-on-surface-variant">
                            No issues here
                          </p>
                        )}
                      </DropColumn>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'tasks' && (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {TASK_COLS.map((col) => {
            const colTasks = filteredTasks.filter((t: { status: string }) => t.status === col.status);
            return (
              <DropColumn
                key={col.status}
                label={col.label}
                color={col.color}
                bg={col.bg}
                count={colTasks.length}
                status={col.status}
                onDrop={handleTaskDrop}
                dragType="taskId"
              >
                {colTasks.map((task: { id: string }) => (
                  <DraggableTaskCard
                    key={task.id}
                    task={task as never}
                    highlight={changedTaskIds.has(task.id)}
                  />
                ))}
                {colTasks.length === 0 && (
                  <p className="py-8 text-center text-xs text-on-surface-variant">
                    No tasks here
                  </p>
                )}
              </DropColumn>
            );
          })}
        </div>
      )}

      <IssueDetailModal
        open={!!selectedIssueId}
        issueId={selectedIssueId}
        projectSlug={slug}
        onClose={() => setSelectedIssueId(null)}
      />


      <ToastContainer toasts={toasts} />
    </div>
  );
}
