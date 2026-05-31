"use client";

// Pipeline kanban screen (`/v2/projects/[slug]/pipeline`, ISS-295). 7 stage
// columns (triage→…→release); cards are issues grouped by STATUS_TO_STAGE with
// the live run status overlaid by issueId. Live via WS (the project room
// invalidates `['issues','search']` + `['pipeline-runs','list']`). Mirrors the
// prototype `web-redesign-plan/ui-kit/PipelineScreen.jsx`.
import { useMemo, useState } from "react";
import {
  ErrorState,
  IconButton,
  KanbanBoard,
  KanbanCard,
  KanbanColumn,
  KanbanColumnSkeleton,
  LiveDot,
  STAGES,
  Tooltip,
} from "@/design";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { formatApiError } from "@/lib/api/error";
import {
  groupIssuesByStage,
  initialsFor,
  issueStatusToStatusKey,
  runStatusToStatusKey,
  runsByIssue,
} from "../derive";
import { useProjectIssues, useProjectRuns } from "../hooks";
import type { PipelineIssueRow } from "../types";
import { RunDetail } from "./run-detail";

interface PipelineBoardProps {
  scope: { projectId: string; slug: string };
}

interface Selection {
  issue: PipelineIssueRow;
  runId: string | null;
}

export function PipelineBoard({ scope }: PipelineBoardProps) {
  const { projectId, slug } = scope;
  const [selected, setSelected] = useState<Selection | null>(null);

  // Live updates: this project's room invalidates the board's queries.
  useRoom(projectRoom(projectId));

  const issuesQ = useProjectIssues(projectId);
  const runsQ = useProjectRuns(projectId);

  const runIndex = useMemo(() => runsByIssue(runsQ.data?.items), [runsQ.data]);
  const groups = useMemo(() => groupIssuesByStage(issuesQ.data?.items), [issuesQ.data]);

  return (
    <div className="flex h-full min-h-0 flex-col px-4 pb-4 pt-5 sm:px-6">
      <header className="mb-3 flex flex-none items-center gap-3">
        <h1 className="fg-h2">Pipeline</h1>
        <p className="fg-body-sm hidden text-muted sm:block">
          Issues flow left → right; a stage starts once the previous finishes.
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
          {STAGES.map((s) => (
            <div key={s.key} className="w-[248px] flex-none">
              <KanbanColumnSkeleton />
            </div>
          ))}
        </KanbanBoard>
      ) : (
        <KanbanBoard>
          {groups.map((group) => (
            <KanbanColumn key={group.stage} stage={group.stage} count={group.issues.length}>
              {group.issues.map((issue) => {
                const run = issue.id ? runIndex.get(issue.id) : undefined;
                const status = run
                  ? runStatusToStatusKey(run.status)
                  : issueStatusToStatusKey(issue.status);
                const initials = initialsFor(issue.assigneeId);
                return (
                  <KanbanCard
                    key={issue.id}
                    id={issue.displayId}
                    title={issue.title}
                    stage={group.stage}
                    status={status}
                    assignee={initials ? { initials } : undefined}
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
        issue={selected?.issue ?? null}
        runId={selected?.runId ?? null}
        slug={slug}
      />
    </div>
  );
}
