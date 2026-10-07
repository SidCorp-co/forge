"use client";

// Bulk-action bar for the Issues list (ISS-463). Renders when ≥1 row is
// selected and applies ONE field — status or priority — to every selected
// issue via `useBulkUpdateIssues` (a fan-out over the same per-row
// transition/patch endpoints, tallied once with a single summary toast).
//
// Set-status offers only the moves every selected row's core read offers (`moves`, needing
// no reason) — so a bulk
// pick can't mass-409 (mirrors the per-row ISS-308 E1 guard). The control is
// disabled, with the reason rendered beside it, when that intersection is
// empty. Priority has no
// state-machine constraint, so all five values are offered — except while a
// drive job is live on any selected issue, which refuses both controls together
// because the job writes both fields (ISS-1010).

import { useId, useState } from "react";
import { Button, Menu, type MenuItem } from "@/design";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { agentHoldsSelection, heldInSelection } from "../edit-lock";
import { type BulkUpdate, useBulkUpdateIssues } from "../hooks";
import { ISSUE_PRIORITIES, type IssueRow, type IssueStatus } from "../types";
import { BatchReleaseDialog, type BatchReleaseIssue } from "./batch-release-dialog";

const BATCH_RELEASE_GATE = "awaiting_release" as const;

/** The moves every selected row offers that need no reason, in the first row's order. */
function commonMoves(rows: readonly IssueRow[]): IssueStatus[] {
  const [first, ...rest] = rows;
  if (!first) return [];
  return first.moves
    .filter((m) => !m.needsReason && rest.every((r) => r.moves.some((o) => o.to === m.to)))
    .map((m) => m.to);
}

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

function canBatchRelease(rows: IssueRow[], t: Copy): { enabled: boolean; reason?: string } {
  if (rows.length === 0) return { enabled: false };
  const notAtGate = rows.filter((r) => r.status !== BATCH_RELEASE_GATE);
  if (notAtGate.length > 0) {
    return { enabled: false, reason: notAtGate.length > 1 ? t("issues.bulk.notAtGateMany", { n: notAtGate.length }) : t("issues.bulk.notAtGateOne") };
  }
  const claimed = rows.filter((r) => r.releaseBatchRunId != null);
  if (claimed.length > 0) {
    return { enabled: false, reason: claimed.length > 1 ? t("issues.bulk.claimedMany", { n: claimed.length }) : t("issues.bulk.claimedOne") };
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
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const statusReasonId = useId();
  const t = useCopy();
  const L = useLabel();
  const count = selectedRows.length;
  if (count === 0) return null;

  const ids = selectedRows.map((r) => r.id);
  const statusTargets = commonMoves(selectedRows);
  const heldCount = heldInSelection(selectedRows);
  const heldReason = heldCount > 0 ? agentHoldsSelection(t, heldCount, count) : null;
  const noCommonStatus = statusTargets.length === 0;
  const batchRelease = canBatchRelease(selectedRows, t);

  const run = (update: BulkUpdate) =>
    bulk.mutate({ ids, update }, { onSuccess: onCleared });

  const statusItems: MenuItem[] = statusTargets.map((s) => ({
    label: L("issueStatus", s),
    onSelect: () => run({ kind: "status", toStatus: s }),
  }));
  const priorityItems: MenuItem[] = ISSUE_PRIORITIES.map((p) => ({
    label: L("issuePriority", p),
    onSelect: () => run({ kind: "priority", priority: p }),
  }));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 shadow-sm">
        <span className="fg-body-sm font-medium text-fg">{t("issues.bulk.selected", { n: count })}</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {heldReason ? (
            <RefusedAction
              labels={[t("issues.bulk.setStatus"), t("issues.bulk.setPriority")]}
              reasonId={statusReasonId}
              reason={heldReason}
            />
          ) : (
            <>
              {noCommonStatus ? (
                <RefusedAction
                  labels={[t("issues.bulk.setStatus")]}
                  reasonId={statusReasonId}
                  reason={t("issues.bulk.noCommonStatus")}
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
                      {t("issues.bulk.setStatus")}
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
                    {t("issues.bulk.setPriority")}
                  </Button>
                }
              />
            </>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!batchRelease.enabled || bulk.isPending}
            title={batchRelease.reason ?? t("issues.bulk.batchHint")}
            onClick={() => setBatchDialogOpen(true)}
          >
            {t("issues.bulk.batchRelease")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCleared}
            disabled={bulk.isPending}
          >
            {t("issues.bulk.clearSelection")}
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
