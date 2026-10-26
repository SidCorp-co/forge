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
import {
  BULK_SHARES_ONE_REASON,
  bulkAllowedStatuses,
  priorityLabel,
  transitionLabels,
} from "../derive";
import { agentHoldsSelection, heldInSelection } from "../edit-lock";
import { type BulkUpdate, useBulkUpdateIssues, useStatusExits } from "../hooks";
import { askWhoReleases } from "../release-who";
import { ISSUE_PRIORITIES, type IssueRow } from "../types";
import { BatchReleaseDialog, type BatchReleaseIssue } from "./batch-release-dialog";
import { TransitionReasonDialog } from "./transition-reason-dialog";

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

function canBatchRelease(
  rows: IssueRow[],
  mayRelease: boolean,
): { enabled: boolean; reason?: string; whoMay?: true } {
  if (rows.length === 0) return { enabled: false };
  const notAtGate = rows.filter((r) => r.status !== BATCH_RELEASE_GATE);
  if (notAtGate.length > 0) {
    return { enabled: false, reason: `${notAtGate.length} selected issue${notAtGate.length > 1 ? "s are" : " is"} not awaiting release` };
  }
  const claimed = rows.filter((r) => r.releaseBatchRunId != null);
  if (claimed.length > 0) {
    return { enabled: false, reason: `${claimed.length} issue${claimed.length > 1 ? "s are" : " is"} already claimed by a batch release` };
  }
  // Said beside the button, not only in its title, so a touch or keyboard reader gets it too.
  if (!mayRelease) return { enabled: false, reason: askWhoReleases("them"), whoMay: true };
  return { enabled: true };
}

export function BulkActionBar({
  projectId,
  selectedRows,
  onCleared,
  canRelease,
}: {
  projectId: string;
  /** Whether the reader holds the role the release door takes (ISS-1300 r5). */
  canRelease: boolean;
  /** The currently-selected rows (page-scoped). */
  selectedRows: IssueRow[];
  /** Clear the selection — called on Clear and after a successful apply. */
  onCleared: () => void;
}) {
  const bulk = useBulkUpdateIssues();
  const { exits, isPending: exitsPending, failure: exitsFailure } = useStatusExits();
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [holdOpen, setHoldOpen] = useState(false);
  const statusReasonId = useId();
  const releaseReasonId = useId();
  const count = selectedRows.length;
  if (count === 0) return null;

  const ids = selectedRows.map((r) => r.id);
  const statusTargets = bulkAllowedStatuses(exits, selectedRows);
  const heldCount = heldInSelection(selectedRows);
  const heldReason = heldCount > 0 ? agentHoldsSelection(heldCount, count) : null;
  const statusUnavailable = exitsPending
    ? "Loading the status moves…"
    : exitsFailure;
  const noCommonStatus = statusTargets.length === 0;
  const batchRelease = canBatchRelease(selectedRows, canRelease);

  const run = (update: BulkUpdate) =>
    bulk.mutate({ ids, update }, { onSuccess: onCleared });

  const statusNames = transitionLabels(statusTargets);
  const statusItems: MenuItem[] = statusTargets.map((s, i) => ({
    label: statusNames[i],
    // On hold needs a reason: asked once for the selection, sent with every issue.
    onSelect: () =>
      BULK_SHARES_ONE_REASON.has(s) ? setHoldOpen(true) : run({ kind: "status", toStatus: s }),
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
            aria-describedby={batchRelease.whoMay ? releaseReasonId : undefined}
            onClick={() => setBatchDialogOpen(true)}
          >
            Batch release
          </Button>
          {batchRelease.whoMay && (
            <span id={releaseReasonId} className="fg-body-sm text-subtle">
              {batchRelease.reason}
            </span>
          )}
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
      <TransitionReasonDialog
        status={holdOpen ? "on_hold" : null}
        issueCount={count}
        loading={bulk.isPending}
        onConfirm={(reason) => {
          bulk.mutate(
            { ids, update: { kind: "status", toStatus: "on_hold", reason } },
            {
              onSuccess: () => {
                setHoldOpen(false);
                onCleared();
              },
            },
          );
        }}
        onClose={() => setHoldOpen(false)}
      />
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
