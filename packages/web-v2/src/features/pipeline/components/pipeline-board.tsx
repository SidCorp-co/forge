"use client";

// Pipeline kanban screen (`/projects/[slug]/pipeline`, ISS-295), and the Issues screen's Board tab.
//
// One column per LANE LABEL — the same word the issue's own status chip says — with the live run
// status overlaid by issueId. Until ISS-999 the columns were the seven stages of a pipeline the
// kernel deleted in ISS-897, filled from a 15-key status→stage map that answered `triage` for
// `releasing` and `dropped`. Live via WS (the project room invalidates `['issues','search']` +
// `['pipeline-runs','list']`).

import { useMemo, useState } from "react";
import {
  ErrorState,
  IconButton,
  KanbanBoard,
  KanbanCard,
  KanbanColumn,
  KanbanColumnSkeleton,
  LiveDot,
  PageTitle,
  Tooltip,
} from "@/design";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { formatApiError } from "@/lib/api/error";
import { useLaneLabeller } from "@/features/issues/vocabulary";
import { boardColumns, cardStatus, formatUsd, groupIssuesByLabel, runsByIssue } from "../derive";
import { useProjectIssues, useProjectRuns } from "../hooks";
import type { PipelineIssueRow } from "../types";
import { RunDetail } from "./run-detail";

interface PipelineBoardProps {
  scope: { projectId: string; slug: string };
  /** When embedded inside another screen (the Issues Board tab, ISS-364) the
   *  host renders the page header + view switcher, so the board hides its own
   *  `<header>` and trims its top padding. */
  embedded?: boolean;
  /** False for project viewers (read-only). The board itself has no
   *  drag-and-drop (cards are click-to-open), so this gates the mutation
   *  affordances in the RunDetail drawer (quick actions + run controls).
   *  Optional, defaults true so other callers keep their behaviour. */
  canWrite?: boolean;
}

interface Selection {
  issue: PipelineIssueRow;
  runId: string | null;
}

export function PipelineBoard({ scope, embedded = false, canWrite = true }: PipelineBoardProps) {
  const { projectId, slug } = scope;
  const [selected, setSelected] = useState<Selection | null>(null);
  const labelStatus = useLaneLabeller();

  // Live updates: this project's room invalidates the board's queries.
  useRoom(projectRoom(projectId));

  const issuesQ = useProjectIssues(projectId);
  const runsQ = useProjectRuns(projectId);

  const runIndex = useMemo(() => runsByIssue(runsQ.data?.items), [runsQ.data]);
  const groups = useMemo(() => groupIssuesByLabel(issuesQ.data?.items), [issuesQ.data]);

  // Keep the open drawer's issue snapshot in sync with the live list: editing
  // status/priority/assignee from the quick-action bar invalidates `['issues']`,
  // so re-derive the freshest row by id (falling back to the snapshot) — the
  // header chip + quick-bar selects then reflect the change without reopening.
  const selectedIssue = useMemo(() => {
    if (!selected) return null;
    return issuesQ.data?.items.find((i) => i.id === selected.issue.id) ?? selected.issue;
  }, [selected, issuesQ.data]);

  return (
    <div
      className={
        embedded
          ? "flex h-full min-h-0 flex-col px-4 pb-4 sm:px-6"
          : "flex h-full min-h-0 flex-col px-4 pb-4 pt-5 sm:px-6"
      }
    >
      <header className={`mb-3 flex flex-none items-center gap-3${embedded ? " hidden" : ""}`}>
        <PageTitle className="fg-h2">Pipeline</PageTitle>
        <p className="fg-body-sm hidden text-muted sm:block">
          One column per state an issue can be in. There is no order between them.
        </p>
        <div className="ml-auto flex items-center gap-3">
          <LiveDot state="live" />
          <Tooltip
            side="bottom"
            label="Click a card to inspect its run · pause / resume / cancel from the panel"
          >
            <IconButton icon="help" variant="ghost" size="sm" aria-label="Pipeline help" />
          </Tooltip>
        </div>
      </header>

      {issuesQ.isError || runsQ.isError ? (
        <ErrorState
          message={formatApiError(issuesQ.error ?? runsQ.error)}
          onRetry={() => {
            issuesQ.refetch();
            runsQ.refetch();
          }}
        />
      ) : issuesQ.isLoading ? (
        <KanbanBoard>
          {boardColumns().map((label) => (
            <div key={label} className="w-[248px] flex-none">
              <KanbanColumnSkeleton />
            </div>
          ))}
        </KanbanBoard>
      ) : (
        <KanbanBoard>
          {groups.map((group) => (
            <KanbanColumn
              key={group.label}
              title={group.title}
              color={group.color}
              count={group.issues.length}
              emptyHint={`No issues are ${group.title.toLowerCase()}.`}
            >
              {group.issues.map((issue) => {
                const run = issue.id ? runIndex.get(issue.id) : undefined;
                const card = cardStatus(issue, run, labelStatus);
                return (
                  <KanbanCard
                    key={issue.id}
                    id={issue.displayId}
                    title={issue.title}
                    status={card.status}
                    statusLabel={card.label}
                    statusDomain={card.domain}
                    held={issue.status === "on_hold"}
                    {...(card.waitingReason ? { waitingReason: card.waitingReason } : {})}
                    cost={
                      run && run.cost.estimatedCost > 0
                        ? formatUsd(run.cost.estimatedCost)
                        : undefined
                    }
                    onClick={() => setSelected({ issue, runId: run?.id ?? null })}
                  />
                );
              })}
            </KanbanColumn>
          ))}
        </KanbanBoard>
      )}

      <RunDetail
        open={!!selected}
        onClose={() => setSelected(null)}
        issue={selectedIssue}
        runId={selected?.runId ?? null}
        slug={slug}
        canWrite={canWrite}
      />
    </div>
  );
}
