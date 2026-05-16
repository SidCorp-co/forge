'use client';

import { Button, Checkbox, SegmentedControl, Select } from '@/components/ui';
import {
  ALL_ISSUE_COLS,
  BOARD_DENSITY_OPTIONS,
  BOARD_GROUP_BY_OPTIONS,
  BOARD_VIEW_OPTIONS,
  type BoardDensity,
  type BoardGroupBy,
} from '../constants';
import type { IssueStatus } from '@/features/issue/types';

interface BoardToolbarProps {
  viewMode: 'issues' | 'tasks';
  onViewModeChange: (v: 'issues' | 'tasks') => void;
  visibleCols: Record<IssueStatus, boolean>;
  showColPicker: boolean;
  onToggleColPicker: () => void;
  onCloseColPicker: () => void;
  onToggleCol: (status: IssueStatus) => void;
  density: BoardDensity;
  onDensityChange: (v: BoardDensity) => void;
  groupByRow: BoardGroupBy;
  onGroupByRowChange: (v: BoardGroupBy) => void;
  assignees: string[];
  assigneeFilter: string;
  onAssigneeFilterChange: (v: string) => void;
  agentFilter: string;
  onAgentFilterChange: (v: string) => void;
}

export function BoardToolbar({
  viewMode,
  onViewModeChange,
  visibleCols,
  showColPicker,
  onToggleColPicker,
  onCloseColPicker,
  onToggleCol,
  density,
  onDensityChange,
  groupByRow,
  onGroupByRowChange,
  assignees,
  assigneeFilter,
  onAssigneeFilterChange,
  agentFilter,
  onAgentFilterChange,
}: BoardToolbarProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <SegmentedControl options={BOARD_VIEW_OPTIONS} value={viewMode} onChange={onViewModeChange} />

      {viewMode === 'issues' && (
        <div className="relative">
          <Button
            variant="secondary"
            size="xs"
            onClick={onToggleColPicker}
            className="gap-1"
          >
            Columns
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </Button>
          {showColPicker && (
            <>
              <div className="fixed inset-0 z-10" onClick={onCloseColPicker} />
              <div className="absolute left-0 top-full z-20 mt-1 w-48 max-w-[calc(100vw-2rem)] rounded-lg border bg-surface-container-low py-1 shadow-lg">
                {ALL_ISSUE_COLS.map((col) => (
                  <label
                    key={col.status}
                    className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm hover:bg-surface-container-low"
                  >
                    <Checkbox
                      checked={visibleCols[col.status]}
                      onChange={() => onToggleCol(col.status)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {viewMode === 'issues' && (
        <>
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">
            Group by row
            <Select
              value={groupByRow}
              onChange={(e) => onGroupByRowChange(e.currentTarget.value as BoardGroupBy)}
            >
              {BOARD_GROUP_BY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <SegmentedControl
            options={BOARD_DENSITY_OPTIONS}
            value={density}
            onChange={onDensityChange}
          />
        </>
      )}

      {viewMode === 'tasks' && (
        <>
          <Select value={assigneeFilter} onChange={(e) => onAssigneeFilterChange(e.currentTarget.value)}>
            <option value="all">All assignees</option>
            {assignees.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          <Select value={agentFilter} onChange={(e) => onAgentFilterChange(e.currentTarget.value)}>
            <option value="all">All agent statuses</option>
            <option value="idle">Idle</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </Select>
        </>
      )}
    </div>
  );
}
