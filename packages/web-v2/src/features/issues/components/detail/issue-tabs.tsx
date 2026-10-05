import {
  Checkbox,
  EmptyPanelLine,
  ErrorState,
  Markdown,
  SegmentedControl,
  Skeleton,
  ViewHeading,
} from "@/design";
import type { IssueStepOutcome } from "@forge/contracts/issue-standing";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import type { useActivity, useAttachments, useComments } from "../../detail-hooks";
import type { useIssueStandingOf, useProjectMembers } from "../../hooks";
import type { IssueAgentSession, IssueDetail } from "../../types";
import { ActivityFeed } from "../activity-feed";
import { CommentThread } from "../comment-thread";
import { CriteriaList } from "../criteria-list";
import { IssueDescription } from "../issue-description";
import { ReleaseNoteCard } from "../release-note-card";
import { SessionGroupTimeline } from "../session-group-timeline";
import { StepArtifactCard } from "../step-artifact-card";

export const ISSUE_TABS = ["overview", "criteria", "runs", "mockups", "activity"] as const;

export type ActivityThread = "comments" | "activity";

export function OverviewTab({
  issue,
  attachmentsQ,
  canWrite,
}: {
  issue: IssueDetail;
  attachmentsQ: ReturnType<typeof useAttachments>;
  canWrite: boolean;
}) {
  return (
    <div className="grid gap-8" data-testid="view-overview">
      <ReleaseNoteCard issue={issue} />
      <IssueDescription
        issue={issue}
        attachments={attachmentsQ.data ?? []}
        attachmentsLoading={attachmentsQ.isLoading}
        attachmentsError={attachmentsQ.isError ? attachmentsQ.error : null}
        canWrite={canWrite}
      />
      <section aria-label="Plan">
        <ViewHeading>Plan</ViewHeading>
        {issue.plan ? (
          <Markdown>{issue.plan}</Markdown>
        ) : (
          <p className="text-13 text-subtle">Not written yet; the plan step writes it once a master takes the issue.</p>
        )}
      </section>
    </div>
  );
}

/** The criteria rows when the issue has them, else the checklist parsed from its acceptance-criteria text. */
export function CriteriaTab({
  issueId,
  hasCriteriaRows,
  checklist,
}: {
  issueId: string;
  hasCriteriaRows: boolean;
  checklist: { key: string; text: string; checked: boolean }[];
}) {
  return (
    <div data-testid="view-criteria">
      {hasCriteriaRows ? (
        <CriteriaList issueId={issueId} />
      ) : checklist.length > 0 ? (
        <section aria-label="Acceptance criteria">
          <ViewHeading>Acceptance criteria</ViewHeading>
          <ul className="space-y-2">
            {checklist.map((item) => (
              <li key={item.key}>
                <Checkbox checked={item.checked} disabled label={item.text} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-13 text-subtle">No criteria yet; the plan step writes them.</p>
      )}
    </div>
  );
}

export function RunsTab({
  sessions,
  standingQ,
  stepOutcomes,
  expandedStep,
  onToggleStep,
}: {
  sessions: IssueAgentSession[];
  standingQ: ReturnType<typeof useIssueStandingOf>;
  stepOutcomes: IssueStepOutcome[];
  expandedStep: string | null;
  onToggleStep: (step: string) => void;
}) {
  return (
    <div className="grid gap-6" data-testid="view-runs">
      {/* Session-group continuity (ISS-376) — resumed/fresh per step. Self-hides when no session carries group metadata. */}
      <SessionGroupTimeline sessions={sessions} />
      {standingQ.isLoading ? (
        <EmptyPanelLine title="Steps" status="Loading…" />
      ) : standingQ.isError ? (
        <EmptyPanelLine title="Steps" status="Couldn't load" detail={formatApiError(standingQ.error)} />
      ) : stepOutcomes.length === 0 ? (
        <EmptyPanelLine title="Steps" status="None yet" detail="Steps appear here as agents record them." />
      ) : (
        <section aria-label="Steps">
          <ViewHeading>Steps</ViewHeading>
          <div className="space-y-2">
            {stepOutcomes.map((outcome) => (
              <StepArtifactCard
                key={outcome.step}
                outcome={outcome}
                open={expandedStep === outcome.step}
                onToggle={() => onToggleStep(outcome.step)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function ActivityTab({
  issueId,
  thread,
  onThread,
  commentsQ,
  activityQ,
  members,
  canWrite,
}: {
  issueId: string;
  thread: ActivityThread;
  onThread: (thread: ActivityThread) => void;
  commentsQ: ReturnType<typeof useComments>;
  activityQ: ReturnType<typeof useActivity>;
  members: ReturnType<typeof useProjectMembers>["data"];
  canWrite: boolean;
}) {
  return (
    <section id="issue-comments" aria-label="Activity" data-testid="view-activity">
      <SegmentedControl
        options={[
          { value: "comments", label: "Comments", count: commentsQ.data?.totalCount },
          { value: "activity", label: "History", count: activityQ.data?.items.length },
        ]}
        value={thread}
        onChange={onThread}
      />
      <div className="mt-4">
        {thread === "comments" &&
          (commentsQ.isLoading ? (
            <TabLoading />
          ) : commentsQ.isError ? (
            <TabError query={commentsQ} what="comments" />
          ) : (
            <CommentThread issueId={issueId} comments={commentsQ.data?.items ?? []} members={members} readOnly={!canWrite} />
          ))}
        {thread === "activity" &&
          (activityQ.isLoading ? (
            <TabLoading />
          ) : activityQ.isError ? (
            <TabError query={activityQ} what="history" />
          ) : (
            <ActivityFeed items={activityQ.data?.items ?? []} />
          ))}
      </div>
    </section>
  );
}

/** Skeleton placeholder for the detail tab bodies (overview / runs / activity)
 *  while their queries load — replaces the bare "Loading …" text (ISS-308 F1). */
function TabLoading() {
  return (
    <div className="space-y-3" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-2.5">
          <Skeleton variant="circle" className="size-[26px] flex-none" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton variant="text" className="w-32" />
            <Skeleton variant="text" className="w-full max-w-[24rem]" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Error body for a detail tab whose query failed. Retry is offered only where
 *  retrying could change the answer (ISS-1160) — a refusal the same request
 *  will meet again gets no dead Retry button. */
function TabError({
  query,
  what,
}: {
  query: { error: unknown; refetch: () => unknown };
  what: string;
}) {
  return (
    <ErrorState
      title={`Couldn't load ${what}`}
      message={formatApiError(query.error)}
      onRetry={isRetryableApiError(query.error) ? () => query.refetch() : undefined}
    />
  );
}
