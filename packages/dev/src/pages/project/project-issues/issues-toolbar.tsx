import { Link } from "react-router-dom";
import { FormInput, FormSelect, Button } from "@/components/ui";
import type { IssueStatus, IssuePriority } from "@/lib/types";
import type { SortOption } from "./hooks";
import { StatusMultiSelect } from "./status-multi-select";

interface IssuesToolbarProps {
  slug: string | undefined;
  searchQuery: string;
  statusFilter: IssueStatus[];
  priorityFilter: IssuePriority | "all";
  categoryFilter: string;
  sortBy: SortOption;
  categories: string[];
  checkedCount: number;
  allStatuses: { value: string; label: string }[];
  allPriorities: { value: string; label: string }[];
  onSearchChange: (value: string) => void;
  onStatusChange: (value: IssueStatus[]) => void;
  onPriorityChange: (value: IssuePriority | "all") => void;
  onCategoryChange: (value: string) => void;
  onSortChange: (value: SortOption) => void;
  onStartSession: () => void;
}

export function IssuesToolbar({
  slug,
  searchQuery,
  statusFilter,
  priorityFilter,
  categoryFilter,
  sortBy,
  categories,
  checkedCount,
  allStatuses,
  allPriorities,
  onSearchChange,
  onStatusChange,
  onPriorityChange,
  onCategoryChange,
  onSortChange,
  onStartSession,
}: IssuesToolbarProps) {
  return (
    <>
      <div className="mb-3">
        <FormInput
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search issues…"
          aria-label="Search issues"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusMultiSelect
            selected={statusFilter}
            onChange={onStatusChange}
          />

          <FormSelect
            aria-label="Filter by priority"
            value={priorityFilter}
            onChange={(e) => onPriorityChange(e.target.value as IssuePriority | "all")}
          >
            <option value="all">All priorities</option>
            {allPriorities.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </FormSelect>

          {categories.length > 0 && (
            <FormSelect
              aria-label="Filter by category"
              value={categoryFilter}
              onChange={(e) => onCategoryChange(e.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </FormSelect>
          )}

          <FormSelect
            aria-label="Sort issues"
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as SortOption)}
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="priority">Priority</option>
            <option value="updated">Recently Updated</option>
          </FormSelect>
        </div>

        <div className="flex items-center gap-2">
          {checkedCount > 0 && (
            <Button
              onClick={onStartSession}
              className="bg-green-600 hover:bg-green-700"
            >
              Start Session ({checkedCount})
            </Button>
          )}
          <Link
            to={`/project/${slug}/issues/new`}
            className="rounded-lg bg-black px-4 py-2 text-sm text-white hover:bg-gray-800"
          >
            New Issue
          </Link>
        </div>
      </div>
    </>
  );
}
