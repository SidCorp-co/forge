"use client";

// Bulk-action bar for the Issues list (ISS-463). Renders when ≥1 row is
// selected and applies ONE field — status or priority — to every selected
// issue via `useBulkUpdateIssues` (a fan-out over the same per-row
// transition/patch endpoints, tallied once with a single summary toast).
//
// Set-status offers only `bulkAllowedStatuses()` — the intersection, across the
// whole selection, of the exits core declares for each row's rung — so a bulk
// pick can't mass-409 (mirrors the per-row ISS-308 E1 guard). The control is
// disabled, with the reason rendered beside it, both when that intersection is
// empty and while the exits themselves are unread. Priority has no
// state-machine constraint, so all five values are offered — except while a
// drive job is live on any selected issue, which refuses both controls together
// because the job writes both fields (ISS-1010).

import { useId, useState } from "react";
import { Button, Menu, type MenuItem } from "@/design";
import { bulkAllowedStatuses, priorityLabel, transitionLabels } from "../derive";
import { agentHoldsSelection, heldInSelection } from "../edit-lock";
import { useLaneLabeller } from "../vocabulary";
import { type BulkUpdate, useBulkUpdateIssues, useStatusExits } from "../hooks";
import { ISSUE_PRIORITIES, type IssueRow } from "../types";
import { BatchReleaseDialog, type BatchReleaseIssue } from "./batch-release-dialog";

const BATCH_RELEASE_GATE = "awaiting_release" as const;

/** A bulk action the bar will not run, with the reason rendered beside it. */
function RefusedAction({
  labels,
  reason,
  reasonId,
}: { labels: string[]; reason: string; reasonId: string }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {labels.map((label) => (
        <Button
          key={label}
          variant="secondary"
          size="sm"
          icon="chevronDown"
          disabled
          aria-describedby={reasonId}
        >
          {label}
        </Button>
      ))}
      <span id={reasonId} role="status" className="fg-body-sm text-subtle">
        {reason}
      </span>
    </span>
  );
}

function canBatchRelease(rows: IssueRow[]): { enabled: boolean; reason?: string } {
  if (rows.length === 0) return { enabled: false };
  const notAtGate = rows.filter((r) => r.status !== BATCH_RELEASE_GATE);
  if (notAtGate.length > 0) {
    return { enabled: false, reason: `${notAtGate.length} selected issue${notAtGate.length > 1 ? "s are" : " is"} not awaiting release` };
  }
  const claimed = rows.filter((r) => r.releaseBatchRunId != null);
  if (claimed.length > 0) {
    return { enabled: false, reason: `${claimed.length} issue${claimed.length > 1 ? "s are" : " is"} already claimed by a batch release` };
  }
  return { enabled: true };
}

export function BulkActionBar({
  projectId,
  selectedRows,
  onCleared,
}: {
  projectId: string;
  /** The currently-selected rows (page-scoped). */
  selectedRows: IssueRow[];
  /** Clear the selection — called on Clear and after a successful apply. */
  onCleared: () => void;
}) {
  const bulk = useBulkUpdateIssues();
  const laneLabel = useLaneLabeller();
  const { exits, isPending: exitsPending, isError: exitsFailed } = useStatusExits();
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const statusReasonId = useId();
  const count = selectedRows.length;
  if (count === 0) return null;

  const ids = selectedRows.map((r) => r.id);
  const statusTargets = bulkAllowedStatuses(exits, selectedRows);
  const heldCount = heldInSelection(selectedRows);
  const heldReason = heldCount > 0 ? agentHoldsSelection(heldCount, count) : null;
  const statusUnavailable = exitsPending
    ? "Loading the status moves…"
    : exitsFailed
      ? "Couldn't load the status moves"
      : null;
  const noCommonStatus = statusTargets.length === 0;
  const batchRelease = canBatchRelease(selectedRows);

  const run = (update: BulkUpdate) =>
    bulk.mutate({ ids, update }, { onSuccess: onCleared });

  const statusNames = transitionLabels(statusTargets, laneLabel);
  const statusItems: MenuItem[] = statusTargets.map((s, i) => ({
    label: statusNames[i],
    onSelect: () => run({ kind: "status", toStatus: s }),
  }));
  const priorityItems: MenuItem[] = ISSUE_PRIORITIES.map((p) => ({
    label: priorityLabel(p),
    onSelect: () => run({ kind: "priority", priority: p }),
  }));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 shadow-sm">
        <span className="fg-body-sm font-medium text-fg">{count} selected</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {heldReason ? (
            <RefusedAction
              labels={["Set status", "Set priority"]}
              reasonId={statusReasonId}
              reason={heldReason}
            />
          ) : (
            <>
              {statusUnavailable || noCommonStatus ? (
                <RefusedAction
                  labels={["Set status"]}
                  reasonId={statusReasonId}
                  reason={statusUnavailable ?? "No status change is valid for every selected issue"}
                />
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
            </>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!batchRelease.enabled || bulk.isPending}
            title={batchRelease.reason ?? "Release selected issues as a batch"}
            onClick={() => setBatchDialogOpen(true)}
          >
            Batch release
          </Button>
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
      <BatchReleaseDialog
        projectId={projectId}
        selectedIssues={batchRelease.enabled ? selectedRows.map((r): BatchReleaseIssue => ({ id: r.id, displayId: r.displayId, title: r.title })) : []}
        open={batchDialogOpen}
        onClose={() => setBatchDialogOpen(false)}
        onSuccess={onCleared}
      />
    </>
  );
}
