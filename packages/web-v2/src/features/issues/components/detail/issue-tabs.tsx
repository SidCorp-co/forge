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
import { useCopy } from "@/lib/i18n/interface-language";
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
  const t = useCopy();
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
      <section aria-label={t("issues.plan.title")}>
        <ViewHeading>{t("issues.plan.title")}</ViewHeading>
        {issue.plan ? (
          <Markdown>{issue.plan}</Markdown>
        ) : (
          <p className="text-13 text-subtle">{t("issues.plan.empty")}</p>
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
  const t = useCopy();
  return (
    <div data-testid="view-criteria">
      {hasCriteriaRows ? (
        <CriteriaList issueId={issueId} />
      ) : checklist.length > 0 ? (
        <section aria-label={t("issues.criteria.acceptance")}>
          <ViewHeading>{t("issues.criteria.acceptance")}</ViewHeading>
          <ul className="space-y-2">
            {checklist.map((item) => (
              <li key={item.key}>
                <Checkbox checked={item.checked} disabled label={item.text} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-13 text-subtle">{t("issues.criteria.empty")}</p>
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
  const t = useCopy();
  return (
    <div className="grid gap-6" data-testid="view-runs">
      {/* Session-group continuity (ISS-376) — resumed/fresh per step. Self-hides when no session carries group metadata. */}
      <SessionGroupTimeline sessions={sessions} />
      {standingQ.isLoading ? (
        <EmptyPanelLine title={t("issues.steps.title")} status={t("issues.steps.loading")} />
      ) : standingQ.isError ? (
        <EmptyPanelLine title={t("issues.steps.title")} status={t("common.couldNotLoad")} detail={formatApiError(standingQ.error)} />
      ) : stepOutcomes.length === 0 ? (
        <EmptyPanelLine title={t("issues.steps.title")} status={t("issues.steps.none")} detail={t("issues.steps.noneHint")} />
      ) : (
        <section aria-label={t("issues.steps.title")}>
          <ViewHeading>{t("issues.steps.title")}</ViewHeading>
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
  const t = useCopy();
  return (
    <section id="issue-comments" aria-label={t("issues.tab.activity")} data-testid="view-activity">
      <SegmentedControl
        options={[
          { value: "comments", label: t("issues.activity.comments"), count: commentsQ.data?.totalCount },
          { value: "activity", label: t("issues.activity.history"), count: activityQ.data?.items.length },
        ]}
        value={thread}
        onChange={onThread}
      />
      <div className="mt-4">
        {thread === "comments" &&
          (commentsQ.isLoading ? (
            <TabLoading />
          ) : commentsQ.isError ? (
            <TabError query={commentsQ} title={t("issues.activity.commentsFailed")} />
          ) : (
            <CommentThread issueId={issueId} comments={commentsQ.data?.items ?? []} members={members} readOnly={!canWrite} />
          ))}
        {thread === "activity" &&
          (activityQ.isLoading ? (
            <TabLoading />
          ) : activityQ.isError ? (
            <TabError query={activityQ} title={t("issues.activity.historyFailed")} />
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
  title,
}: {
  query: { error: unknown; refetch: () => unknown };
  title: string;
}) {
  return (
    <ErrorState
      title={title}
      message={formatApiError(query.error)}
      onRetry={isRetryableApiError(query.error) ? () => query.refetch() : undefined}
    />
  );
}
