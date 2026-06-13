"use client";

// Bulk-action bar for the Issues list (ISS-463). Renders when ≥1 row is
// selected and applies ONE field — status or priority — to every selected
// issue via `useBulkUpdateIssues` (a fan-out over the same per-row
// transition/patch endpoints, tallied once with a single summary toast).
//
// Set-status offers only `bulkAllowedStatuses()` — the intersection of valid
// next states across the whole selection — so a bulk pick can't mass-409
// (mirrors the per-row ISS-308 E1 guard); when there is no common-valid target
// the control is disabled. Priority has no state-machine constraint, so all
// five values are always offered.

import { Button, Menu, type MenuItem } from "@/design";
import { bulkAllowedStatuses, priorityLabel, statusLabel } from "../derive";
import { type BulkUpdate, useBulkUpdateIssues } from "../hooks";
import { ISSUE_PRIORITIES, type IssueRow } from "../types";

export function BulkActionBar({
  selectedRows,
  onCleared,
}: {
  /** The currently-selected rows (page-scoped). */
  selectedRows: IssueRow[];
  /** Clear the selection — called on Clear and after a successful apply. */
  onCleared: () => void;
}) {
  const bulk = useBulkUpdateIssues();
  const count = selectedRows.length;
  if (count === 0) return null;

  const ids = selectedRows.map((r) => r.id);
  const statusTargets = bulkAllowedStatuses(selectedRows);
  const noCommonStatus = statusTargets.length === 0;

  const run = (update: BulkUpdate) =>
    bulk.mutate({ ids, update }, { onSuccess: onCleared });

  const statusItems: MenuItem[] = statusTargets.map((s) => ({
    label: statusLabel(s),
    onSelect: () => run({ kind: "status", toStatus: s }),
  }));
  const priorityItems: MenuItem[] = ISSUE_PRIORITIES.map((p) => ({
    label: priorityLabel(p),
    onSelect: () => run({ kind: "priority", priority: p }),
  }));

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 shadow-sm">
      <span className="fg-body-sm font-medium text-fg">{count} selected</span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {noCommonStatus ? (
          <Button
            variant="secondary"
            size="sm"
            icon="chevronDown"
            disabled
            title="No status change is valid for every selected issue"
          >
            Set status
          </Button>
        ) : (
          <Menu
            align="right"
            items={statusItems}
            trigger={
              <Button
                variant="secondary"
                size="sm"
                icon="chevronDown"
                disabled={bulk.isPending}
              >
                Set status
              </Button>
            }
          />
        )}
        <Menu
          align="right"
          items={priorityItems}
          trigger={
            <Button
              variant="secondary"
              size="sm"
              icon="chevronDown"
              disabled={bulk.isPending}
            >
              Set priority
            </Button>
          }
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={onCleared}
          disabled={bulk.isPending}
        >
          Clear selection
        </Button>
      </span>
    </div>
  );
}
