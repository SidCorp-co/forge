"use client";

// Pipeline kanban screen (`/projects/[slug]/pipeline`, ISS-295), and the Issues screen's Board tab.
//
// One column per STATUS — the same word the issue's own status chip says — plus "No check-in" for
// the in_progress rows nothing holds, with the live run status overlaid by issueId. A run's step is
// not a column: an in_progress card names it ("In progress · Test"). Live via WS (the project room
// invalidates `['issues','search']` + `['pipeline-runs','list']`).

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
  StatusBadge,
  Tooltip,
} from "@/design";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { formatApiError } from "@/lib/api/error";
import { boardColumns, cardStatus, formatUsd, groupIssuesByColumn, runsByIssue } from "../derive";
import { useProjectIssues, useProjectRuns } from "../hooks";
import type { PipelineIssueRow } from "../types";
import { RunDetail } from "./run-detail";
import { TopBarActions } from "@/design/primitives/top-bar-slot";

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

  // Live updates: this project's room invalidates the board's queries.
  useRoom(projectRoom(projectId));

  const issuesQ = useProjectIssues(projectId);
  const runsQ = useProjectRuns(projectId);

  const runIndex = useMemo(() => runsByIssue(runsQ.data?.items), [runsQ.data]);
  const groups = useMemo(() => groupIssuesByColumn(issuesQ.data?.items), [issuesQ.data]);

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
      {!embedded && (
        <>
        <PageTitle hint="One column per state an issue can be in. There is no order between them.">
          Pipeline
        </PageTitle>
        <TopBarActions>
          <LiveDot state="live" />
          <Tooltip
            side="bottom"
            label="Click a card to inspect its run · pause / resume / cancel from the panel"
          >
            <IconButton icon="help" variant="ghost" size="sm" aria-label="Pipeline help" />
          </Tooltip>
        </TopBarActions>
        </>
      )}

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
          {boardColumns().map((key) => (
            <div key={key} className="w-[248px] flex-none">
              <KanbanColumnSkeleton />
            </div>
          ))}
        </KanbanBoard>
      ) : (
        <KanbanBoard>
          {groups.map((group) => (
            <KanbanColumn
              key={group.key}
              title={group.title}
              color={group.color}
              count={group.issues.length}
              emptyHint="No issues in this column."
            >
              {group.issues.map((issue) => {
                const run = issue.id ? runIndex.get(issue.id) : undefined;
                const card = cardStatus(issue, run);
                return (
                  <KanbanCard
                    key={issue.id}
                    id={issue.displayId}
                    title={issue.title}
                    status={card.status}
                    statusLabel={card.label}
                    statusDomain={card.domain}
                    {...(card.pipelineRun
                      ? { badge: <StatusBadge family="pipelineRun" value={card.pipelineRun} /> }
                      : {})}
                    held={issue.status === "on_hold"}
                    {...(card.waitingReason ? { waitingReason: card.waitingReason } : {})}
                    {...(card.note ? { note: card.note } : {})}
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
