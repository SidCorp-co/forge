"use client";

// Awaiting-release card — pipeline runs parked at `awaiting_release`: every
// criterion passed, just waiting for the release to close them. These
// are NOT live/executing work (see `LiveRunsCard`), so they get their own
// list with a calm "Verified" chip instead of the pulsing "running" one, and a
// collapsed default so a large backlog can't push the rest of the dashboard
// (Runners, Upcoming schedules) below the fold.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  PageSection,
  PageSectionBody,
  PageSectionTitle,
  Checkbox,
  Icon,
  StatusChip,
} from "@/design";
import { BatchReleaseDialog, type BatchReleaseIssue } from "@/features/issues/components/batch-release-dialog";
import { formatUsd } from "@/features/pipeline/derive";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import { useCopy } from "@/lib/i18n/interface-language";

const COLLAPSED_LIMIT = 5;

/** Oldest-parked first — the longest a run has sat awaiting release is the
 *  clearest signal of what to triage first. */
function byOldestFirst(runs: PipelineRunListItem[]): PipelineRunListItem[] {
  return [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function AwaitingReleaseCard({
  runs,
  slug,
  projectId,
}: {
  runs: PipelineRunListItem[];
  slug: string;
  projectId: string;
}) {
  const router = useRouter();
  const t = useCopy();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const sorted = byOldestFirst(runs);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = sorted.length - visible.length;
  const selectableAll = sorted.filter((run) => run.issueId != null);
  const selectableVisible = visible.filter((run) => run.issueId != null);
  const selectedCount = selected.size;
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((run) => selected.has(run.issueId as string));

  const selectedIssues: BatchReleaseIssue[] = selectableAll
    .filter((run) => selected.has(run.issueId as string))
    .map((run) => ({
      id: run.issueId as string,
      displayId: run.issueRef ?? (run.issueId as string),
      title: run.issueTitle ?? "",
    }));

  const open = (run: PipelineRunListItem) => {
    router.push(run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`);
  };

  const toggle = (issueId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(issueId);
      else next.delete(issueId);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const run of selectableVisible) {
        if (checked) next.add(run.issueId as string);
        else next.delete(run.issueId as string);
      }
      return next;
    });
  };

  return (
    <>
    <PageSection className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle py-3">
        <div className="flex items-center gap-2">
          <Icon name="check" size={16} className="text-subtle" />
          <PageSectionTitle>{t("overview.flow.awaiting_release")}</PageSectionTitle>
        </div>
        {runs.length > 0 && <span className="fg-caption font-mono text-subtle">{runs.length}</span>}
      </div>
      <PageSectionBody className="flex-1">
        {runs.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">{t("overview.awaiting.empty")}</p>
        ) : (
          <>
            {selectableVisible.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={selectedCount > 0 && !allVisibleSelected}
                  onChange={toggleAllVisible}
                  ariaLabel={allVisibleSelected ? t("issues.bulk.clearSelection") : t("overview.awaiting.selectAll")}
                  label={allVisibleSelected ? t("overview.awaiting.clear") : t("overview.awaiting.selectAll")}
                />
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  disabled={selectedCount === 0}
                  onClick={() => setBatchDialogOpen(true)}
                >
                  {selectedCount > 0 ? t("overview.awaiting.releaseN", { n: selectedCount }) : t("overview.awaiting.release")}
                </Button>
              </div>
            )}
            <ul className="flex flex-col divide-y divide-line-subtle">
              {visible.map((run) => (
                <li
                  key={run.id}
                  className="flex items-center gap-2.5 py-2 transition-colors hover:bg-hover"
                >
                  {run.issueId && (
                    <Checkbox
                      checked={selected.has(run.issueId)}
                      onChange={(checked) => toggle(run.issueId as string, checked)}
                      ariaLabel={t("overview.awaiting.select", { what: run.issueRef ?? t("overview.awaiting.run") })}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => open(run)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <StatusChip status="passed" domain="session" size="sm" />
                    <span className="fg-body-sm min-w-0 flex-1 truncate text-muted">
                      {run.issueRef ? (
                        <>
                          <span className="font-mono text-fg">{run.issueRef}</span>
                          {run.issueTitle ? ` ${run.issueTitle}` : ""}
                        </>
                      ) : (
                        t("overview.awaiting.runTitle")
                      )}
                    </span>
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      {formatUsd(run.cost?.estimatedCost)}
                    </span>
                    <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
                  </button>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="fg-body-sm mt-2 w-full rounded-md py-1.5 text-center text-subtle transition-colors hover:bg-hover hover:text-fg"
              >
                {t("overview.awaiting.showMore", { n: hiddenCount })}
              </button>
            )}
          </>
        )}
      </PageSectionBody>
    </PageSection>
    <BatchReleaseDialog
      projectId={projectId}
      selectedIssues={selectedIssues}
      open={batchDialogOpen}
      onClose={() => setBatchDialogOpen(false)}
      onSuccess={() => {
        setSelected(new Set());
        qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
      }}
    />
    </>
  );
}
