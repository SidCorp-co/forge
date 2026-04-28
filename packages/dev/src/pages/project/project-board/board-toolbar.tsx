import type { IssueStatus } from "@/lib/types";
import { Button, FormCheckbox, FormSelect, SegmentedControl } from "@/components/ui";
import { ALL_ISSUE_COLS } from "./constants";

interface BoardToolbarProps {
  viewMode: "issues" | "tasks";
  onViewModeChange: (mode: "issues" | "tasks") => void;
  visibleCols: Record<IssueStatus, boolean>;
  showColPicker: boolean;
  onToggleColPicker: () => void;
  onCloseColPicker: () => void;
  onToggleCol: (status: IssueStatus) => void;
  assigneeFilter: string;
  onAssigneeFilterChange: (value: string) => void;
  agentFilter: string;
  onAgentFilterChange: (value: string) => void;
  assignees: string[];
}

export function BoardToolbar({
  viewMode,
  onViewModeChange,
  visibleCols,
  showColPicker,
  onToggleColPicker,
  onCloseColPicker,
  onToggleCol,
  assigneeFilter,
  onAssigneeFilterChange,
  agentFilter,
  onAgentFilterChange,
  assignees,
}: BoardToolbarProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <SegmentedControl
        options={[{ value: "issues", label: "Issues" }, { value: "tasks", label: "Tasks" }]}
        value={viewMode}
        onChange={(v) => onViewModeChange(v as "issues" | "tasks")}
      />

      {viewMode === "issues" && (
        <div className="relative">
          <Button
            variant="secondary"
            size="sm"
            onClick={onToggleColPicker}
            className="flex items-center gap-1"
          >
            Columns
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </Button>
          {showColPicker && (
            <>
              <div className="fixed inset-0 z-10" onClick={onCloseColPicker} />
              <div className="absolute left-0 top-full z-20 mt-1 w-48 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                {ALL_ISSUE_COLS.map((col) => (
                  <div key={col.status} className="px-3 py-1.5 hover:bg-gray-50">
                    <FormCheckbox
                      id={`col-${col.status}`}
                      label={col.label}
                      checked={visibleCols[col.status]}
                      onChange={() => onToggleCol(col.status)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {viewMode === "tasks" && (
        <>
          <FormSelect value={assigneeFilter} onChange={(e) => onAssigneeFilterChange(e.target.value)}>
            <option value="all">All assignees</option>
            {assignees.map((a) => <option key={a} value={a}>{a}</option>)}
          </FormSelect>
          <FormSelect value={agentFilter} onChange={(e) => onAgentFilterChange(e.target.value)}>
            <option value="all">All agent statuses</option>
            <option value="idle">Idle</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </FormSelect>
        </>
      )}
    </div>
  );
}
