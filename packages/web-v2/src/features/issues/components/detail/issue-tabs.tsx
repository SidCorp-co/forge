import Link from "next/link";
import {
  Checkbox,
  EmptyPanelLine,
  ErrorState,
  enumLabel,
  Markdown,
  SegmentedControl,
  Skeleton,
  StatusBadge,
  ViewHeading,
} from "@/design";
import type { IssueStepOutcome } from "@forge/contracts/issue-standing";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { agentsListHref, runHref } from "@/lib/routes/agents";
import type { useActivity, useAttachments, useComments } from "../../detail-hooks";
import type { useIssueStandingOf, useProjectMembers } from "../../hooks";
import type { IssueAgentSession, IssueDetail } from "../../types";
import { ActivityFeed } from "../activity-feed";
import { CommentThread } from "../comment-thread";
import { TieCriteria } from "../criteria-acts";
import { CriteriaList } from "../criteria-list";
import { IssueDescription } from "../issue-description";
import { ReleaseNoteCard } from "../release-note-card";
import { SessionGroupTimeline } from "../session-group-timeline";
import { StepArtifactCard } from "../step-artifact-card";
import { CheckTimes } from "./check-times";

export const ISSUE_TABS = ["overview", "criteria", "runs", "mockups", "decisions", "memory", "activity"] as const;

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
      <section aria-label={t("issues.plan.title")} data-highlight="plan">
        <ViewHeading>{t("issues.plan.title")}</ViewHeading>
        {issue.plan ? (
          <Markdown>{issue.plan}</Markdown>
        ) : (
          <p className="text-13 text-subtle" data-testid="issue-plan-empty">
            {t(issue.status === "closed" || issue.status === "dropped" ? "issues.plan.emptyEnded" : "issues.plan.empty")}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The criteria rows when the issue has them, else the checklist parsed from its acceptance-criteria
 * text. A reader who may write records verdicts on the rows and, where the issue delivers a
 * requirement, ties it to that requirement's criteria, a closed issue included.
 */
export function CriteriaTab({
  issue,
  projectId,
  hasCriteriaRows,
  checklist,
  canWrite,
  requirementKey,
}: {
  issue: IssueDetail;
  projectId: string;
  hasCriteriaRows: boolean;
  checklist: { key: string; text: string; checked: boolean }[];
  canWrite: boolean;
  /** The requirement the issue delivers, by key; null where it delivers none. */
  requirementKey: string | null;
}) {
  const t = useCopy();
  const tie =
    canWrite && requirementKey && issue.status !== "dropped" ? (
      <TieCriteria issueId={issue.id} projectId={projectId} requirementKey={requirementKey} />
    ) : null;
  return (
    <div data-testid="view-criteria">
      {hasCriteriaRows ? (
        <CriteriaList issueId={issue.id} judge={canWrite} headingAct={tie} />
      ) : checklist.length > 0 ? (
        <section aria-label={t("issues.criteria.acceptance")}>
          <ViewHeading right={tie}>{t("issues.criteria.acceptance")}</ViewHeading>
          <ul className="space-y-2">
            {checklist.map((item) => (
              <li key={item.key}>
                <Checkbox checked={item.checked} disabled label={item.text} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section aria-label={t("issues.criteria.acceptance")}>
          <ViewHeading right={tie}>{t("issues.criteria.acceptance")}</ViewHeading>
          <p className="text-13 text-subtle">{t(tie ? "issues.criteria.emptyTie" : "issues.criteria.empty")}</p>
        </section>
      )}
    </div>
  );
}

/**
 * The Runs tab counts the issue's runs: a delegated run records no step, so counting steps read 0
 * beside a rail that said the run completed (FB-102). Steps count where no run is on record.
 */
export function runsTabCount(sessions: readonly IssueAgentSession[], stepOutcomes: readonly IssueStepOutcome[]): number {
  return sessions.length > 0 ? sessions.length : stepOutcomes.length;
}

/** Each run on the issue, newest first, linked to where it is read. */
function RunList({ slug, sessions }: { slug: string; sessions: IssueAgentSession[] }) {
  const t = useCopy();
  const time = useTimeFormat();
  const rows = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <section aria-label={t("issues.tab.runs")}>
      <ViewHeading>{t("issues.tab.runs")}</ViewHeading>
      <ul className="divide-y divide-line-subtle border-y border-line-subtle">
        {rows.map((s) => (
          <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2 text-13" data-testid="issue-run">
            <Link
              href={s.pipelineRunId ? runHref(slug, s.pipelineRunId) : `${agentsListHref(slug)}/${encodeURIComponent(s.id)}`}
              className="min-w-0 flex-1 truncate text-link hover:underline"
            >
              {s.title ?? (s.metadata?.jobType ? enumLabel("jobType", String(s.metadata.jobType)) : s.id.slice(0, 8))}
            </Link>
            <StatusBadge family="session" value={s.status} />
            {s.deviceName ? <span className="text-12 text-muted">{s.deviceName}</span> : null}
            <span className="text-12 text-subtle" title={time.dateTime(s.startedAt ?? s.createdAt)}>
              {time.relative(s.startedAt ?? s.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RunsTab({
  issueId,
  slug,
  sessions,
  standingQ,
  stepOutcomes,
  expandedStep,
  onToggleStep,
}: {
  issueId: string;
  slug: string;
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
      {sessions.length > 0 ? <RunList slug={slug} sessions={sessions} /> : null}
      <CheckTimes issueId={issueId} slug={slug} sessions={sessions} />
      {standingQ.isLoading ? (
        <EmptyPanelLine title={t("issues.steps.title")} status={t("issues.steps.loading")} />
      ) : standingQ.isError ? (
        <EmptyPanelLine title={t("issues.steps.title")} status={t("common.couldNotLoad")} detail={formatApiError(standingQ.error)} />
      ) : stepOutcomes.length === 0 ? (
        sessions.length > 0 ? null : <EmptyPanelLine title={t("issues.steps.title")} status={t("issues.steps.none")} detail={t("issues.steps.noneHint")} />
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
