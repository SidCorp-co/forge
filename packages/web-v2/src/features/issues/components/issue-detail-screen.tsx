"use client";

// web-v2 Issue detail (`/projects/[slug]/issues/[id]`, ISS-294): the shared DetailHeader in the top
// bar (back to the list view it came from, key, title, status, one primary action), whose turn as
// banners, then Overview / Criteria / Runs / Activity as tabs (`?tab=`) beside a sticky facts rail —
// the read model's standing over the editable properties. Live via WS on the keys `['issue',id]` /
// `['comments',id]` / `['activities',id]` and `['issues','standing']` — the event-router invalidates
// exactly those, so a query keyed anything else here stops updating and nothing reports it.

import {
  Badge,
  Button,
  Checkbox,
  DetailHeader,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  EmptyPanelLine,
  EmptyState,
  ErrorState,
  FactsGroup,
  FactsRail,
  HelpButton,
  IconButton,
  Markdown,
  Menu,
  ProjectLoader,
  SegmentedControl,
  Skeleton,
  StatusBadge,
  StatusChip,
  useListOrigin,
  useUrlTab,
  type MenuItem,
} from "@/design";
import { useResumeRun } from "@/features/pipeline/hooks";
import { usePolicyDocument } from "@/features/project-settings/config-hooks";
import { useProjects } from "@/features/projects/hooks";
import { canWriteProject } from "@/features/projects/write-access";
import { DecisionPanel, focusDecisionPanel } from "@/features/questions/components/decision-panel";
import { buildShareLink, useRecents } from "@/features/shell";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  allowedTransitions,
  canonicalIssueId,
  deriveBlockerState,
  deriveStepOutcomes,
  isLiveRun,
  runningStepOf,
  issueQueryKey,
  parseChecklist,
  runStatusChip,
  threadQuestionOf,
  workStepOf,
} from "../derive";
import { useCriteria } from "../criteria";
import { deriveQueuedStep } from "../waiting";
import { CriteriaList } from "./criteria-list";
import {
  useActivity,
  useAttachments,
  useComments,
  useCreateComment,
  useIssue,
  useStepDurations,
  useStepHandoffs,
  useTasks,
} from "../detail-hooks";
import {
  useIssueCost,
  useIssueDeps,
  useIssueStandingOf,
  usePatchIssue,
  useProjectMembers,
  useStatusExits,
} from "../hooks";
import { ISSUES_LIST, issuesHref } from "../routes";
import { IssueStandingFacts } from "./issue-standing-bits";
import { useIssuePark } from "../park";
import type { IssueAgentSession, IssueStatus, TaskRow } from "../types";
import { ActivityFeed } from "./activity-feed";
import { AskAboutThis } from "@/features/conversations/components/ask-about-this";
import { AwaitingReleaseBanner } from "./awaiting-release-banner";
import { BlockerBanner } from "./blocker-banner";
import { useGuardedTransition } from "./use-guarded-transition";
import { CommentThread } from "./comment-thread";
import { DescriptionCard } from "./description-card";
import { ReleaseNoteCard } from "./release-note-card";
import { type LiveAgentState, LiveAgentPanel } from "./live-agent-panel";
import { ModulePicker } from "./module-picker";
import { PropertiesRail } from "./properties-rail";
import { SessionGroupTimeline } from "./session-group-timeline";
import { readStart, StartIssueAction } from "./start-issue-action";
import { StepArtifactCard } from "./step-artifact-card";

const TASK_STATUS_TONE: Record<
  TaskRow["status"],
  "neutral" | "cobalt" | "amber" | "green"
> = {
  backlog: "neutral",
  todo: "neutral",
  in_progress: "cobalt",
  in_review: "amber",
  done: "green",
};

const TASK_STATUS_LABELS: Record<TaskRow["status"], string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};


interface IssueDetailScreenProps {
  projectId: string;
  slug: string;
  id: string;
}

export function IssueDetailScreen({
  projectId,
  slug,
  id,
}: IssueDetailScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { push: pushRecent } = useRecents();
  const [tab, setTab] = useUrlTab(ISSUE_TABS);
  const [thread, setThread] = useState<"comments" | "activity" | "tasks">("comments");
  const back = useListOrigin(ISSUES_LIST, issuesHref(slug));
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  useRoom(projectRoom(projectId));

  const projectsQ = useProjects();
  const projectRole = projectsQ.data?.find((p) => p.id === projectId)?.role;
  const canWrite = canWriteProject(projectRole);
  const policyQ = usePolicyDocument(projectId);
  const [modulePickerOpen, setModulePickerOpen] = useState(false);

  // ISS-1160 — `id` off the URL is the display key as often as the row uuid;
  // `projectId` (already resolved from the route's slug) is what lets it
  // resolve on every one of these reads.
  const issueQ = useIssue(id, projectId);
  const canonicalId = canonicalIssueId(id, issueQ.data?.id);
  const commentsQ = useComments(canonicalId, projectId);
  const activityQ = useActivity(canonicalId, projectId);
  const tasksQ = useTasks(canonicalId, projectId);
  const attachmentsQ = useAttachments(canonicalId, projectId);
  const depsQ = useIssueDeps(canonicalId, true, projectId);
  const { exits: statusExits } = useStatusExits();
  const costQ = useIssueCost(canonicalId, true, projectId);
  const membersQ = useProjectMembers(projectId);
  const handoffsQ = useStepHandoffs(projectId, canonicalId);
  const durationsQ = useStepDurations(projectId, canonicalId);

  const patch = usePatchIssue();
  const {
    requestTransition,
    requestParkLeave,
    dialog: reasonDialog,
    isPending: transitionPending,
  } = useGuardedTransition();
  const qc = useQueryClient();
  const resumeRun = useResumeRun();
  // ISS-1160 — a display-key load keys `useIssue` on `id`+`projectId` (never
  // globally unique on `id` alone), so an invalidation naming only the
  // canonical uuid this mutation reports misses that entry; name both.
  const refreshIssue = () => {
    qc.invalidateQueries({ queryKey: ["issue", issue?.id ?? id] });
    qc.invalidateQueries({ queryKey: issueQueryKey(id, projectId) });
  };
  const onResumeRun = (runId: string) =>
    resumeRun.mutate(runId, { onSuccess: refreshIssue });
  const pending = patch.isPending || transitionPending || resumeRun.isPending;

  const issue = issueQ.data;
  const standingQ = useIssueStandingOf(projectId, issue?.displayId);
  // ISS-1310 — one reading of what a person owes this issue, for the banner, the status control and the decision panel.
  const park = useIssuePark(issue?.id, issue?.status);
  const stickyHeader = useRef<HTMLDivElement>(null);
  const answerInThread = useCreateComment(issue?.id ?? "");
  const checklist = useMemo(() => {
    const criteria = parseChecklist(issue?.acceptanceCriteria);
    const counts = new Map<string, number>();

    return criteria.map((item) => {
      const count = counts.get(item.text) ?? 0;
      counts.set(item.text, count + 1);
      return { ...item, key: `${item.text}-${count}` };
    });
  }, [issue?.acceptanceCriteria]);
  const criteriaQ = useCriteria(issue?.id);
  const hasCriteriaRows = (criteriaQ.data?.criteria.length ?? 0) > 0;
  const issueDisplayId = issue?.displayId;
  const issueTitle = issue?.title;

  useEffect(() => {
    if (!issueDisplayId || !issueTitle) return;
    pushRecent({
      kind: "issue",
      id,
      label: `${issueDisplayId} · ${issueTitle}`,
      href: `/projects/${slug}/issues/${id}`,
      icon: "list",
    });
  }, [issueDisplayId, issueTitle, id, slug, pushRecent]);

  function copyLink() {
    const url = buildShareLink(`/projects/${slug}/issues/${id}`);
    navigator.clipboard?.writeText(url).then(
      () => toast({ title: "Link copied", description: url, tone: "success" }),
      () => toast({ title: "Couldn't copy link", tone: "error" }),
    );
  }

  if (issueQ.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading issue…" />
      </div>
    );
  }
  if (issueQ.isError || !issue) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          title="Couldn't load issue"
          message={formatApiError(issueQ.error)}
          onRetry={isRetryableApiError(issueQ.error) ? () => issueQ.refetch() : undefined}
        />
      </div>
    );
  }

  const onTransition = (toStatus: IssueStatus) =>
    requestTransition(issue.id, toStatus, { onSuccess: refreshIssue });
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) =>
    patch.mutate({ id: issue.id, body }, { onSuccess: refreshIssue });

  const blocker = deriveBlockerState(issue, issue.pipelineHealth, depsQ.data, park);
  const liveStep = issue.pipelineHealth?.activeSession?.skill ?? null;
  const stepOutcomes = deriveStepOutcomes(handoffsQ.data, durationsQ.data, {
    activeStep: runningStepOf(issue.pipelineHealth),
    failedStep: issue.failureInfo?.failedStep ?? null,
  });
  const liveSession = pickActiveSession(issue.agentSessions);
  const queuedStep = deriveQueuedStep(issue.pipelineHealth, !!liveSession);
  const agentState: LiveAgentState | null = liveSession
    ? { kind: "live", session: liveSession }
    : queuedStep
      ? { kind: "queued", step: queuedStep }
      : null;

  const focusDecisions = () => {
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => focusDecisionPanel(stickyHeader.current));
    }
  };

  const parkActions = {
    answer: focusDecisions,
    move: onTransition,
    notNeeded: (at: IssueStatus) =>
      requestParkLeave(issue.id, "not_needed", [at], { onSuccess: refreshIssue }),
    moveAnyway: (targets: IssueStatus[]) =>
      requestParkLeave(issue.id, "move_anyway", targets, { onSuccess: refreshIssue }),
  };
  const statusPark = canWrite ? { reading: park, actions: parkActions } : undefined;
  const threadQuestion = park.state === "ready" && park.park ? threadQuestionOf(park.park) : null;

  const isTerminal = issue.status === "awaiting_release" || issue.status === "closed";
  // The menu offers Pause and Reopen only where core's exits row for this status has them.
  const exitsHere = allowedTransitions(statusExits, issue.status, issue.workState?.leftStatus ?? null);
  // The run's state is a session chip beside the issue's lifecycle chip, never merged into it (ISS-360, ISS-1150).
  const runChip = runStatusChip(issue);
  const isRunActive = isLiveRun(runChip) || issue.status === "in_progress" || issue.status === "reopen";
  const openSessions = () =>
    router.push(`/projects/${slug}/agents?issue=${issue.id}`);
  const openPipeline = () => router.push(`/projects/${slug}/pipeline`);
  const start = readStart({
    status: issue.status,
    policy: policyQ.data,
    policyError: policyQ.error,
    role: projectRole,
    sessionContext: issue.sessionContext,
  });

  const moreItems: MenuItem[] = [
    { label: "Open session", icon: "agent", onSelect: openSessions },
    { label: "Open pipeline", icon: "pipeline", onSelect: openPipeline },
    ...(!exitsHere.includes("on_hold") || !canWrite
      ? []
      : [
          {
            label: "Pause (hold)",
            icon: "stop",
            onSelect: () => onTransition("on_hold"),
          } as MenuItem,
        ]),
    ...(!exitsHere.includes("reopen") || !canWrite
      ? []
      : [
          {
            label: "Reopen",
            icon: "rerun",
            onSelect: () => onTransition("reopen"),
          } as MenuItem,
        ]),
    { label: "Copy link", icon: "link", onSelect: copyLink },
  ];

  const tabs = [
    { value: "overview" as const, label: "Overview" },
    { value: "criteria" as const, label: "Criteria", count: criteriaQ.data?.criteria.length ?? checklist.length },
    { value: "runs" as const, label: "Runs", count: stepOutcomes.length },
    { value: "activity" as const, label: "Activity", count: commentsQ.data?.totalCount },
  ];

  const primary =
    start.kind !== "none" && !isRunActive ? (
      <StartIssueAction issueId={issue.id} reading={start} onStarted={refreshIssue} />
    ) : !canWrite || isTerminal ? (
      canWrite ? (
        <Button variant="primary" size="sm" icon="rerun" loading={pending} onClick={() => onTransition("reopen")}>
          Reopen
        </Button>
      ) : (
        <Button variant="primary" size="sm" icon="pipeline" onClick={openPipeline}>
          View pipeline
        </Button>
      )
    ) : isRunActive ? (
      <Button variant="secondary" size="sm" icon="stop" loading={pending} onClick={() => onTransition("on_hold")}>
        Pause
      </Button>
    ) : (
      <Button variant="primary" size="sm" icon="pipeline" onClick={openPipeline}>
        Run pipeline
      </Button>
    );

  const badge = (
    <>
      <StatusBadge family="issue" value={issue.status} step={workStepOf(issue)} tone={standingQ.data?.standing.tone} />
      {/* The live run is its own squared chip beside the lifecycle badge, never merged into it (ISS-360, ISS-1150). */}
      {runChip && <StatusChip status={runChip} stage={runChip === "running" ? (liveStep ?? undefined) : undefined} domain="session" />}
    </>
  );

  const properties = (
    <PropertiesRail
      issue={issue}
      slug={slug}
      cost={costQ.data}
      deps={depsQ.data}
      pending={pending || !canWrite}
      onPatch={onPatch}
      onTransition={onTransition}
      onEditModules={canWrite ? () => setModulePickerOpen(true) : undefined}
      canMarkMerged={canWrite}
      park={statusPark}
    />
  );

  return (
    <div className="min-h-full bg-surface" ref={stickyHeader} data-testid="issue-detail">
      <DetailHeader
        back={{ href: back, label: "Issues" }}
        itemKey={issue.displayId}
        keyTitle={issue.id}
        title={issue.title}
        badge={badge}
        action={
          <span className="flex items-center gap-1.5" data-testid="issue-actions">
            {primary}
            <AskAboutThis kind="issue" refId={issue.displayId} />
            <HelpButton
              summary="The full record for one issue: whose turn it is, then Overview, Criteria, Runs and Activity as tabs beside its facts."
              actions={[
                "Edit properties (status, priority, complexity) in the rail",
                "Start an open issue on a project that starts work by hand, or pause / reopen it, from the header",
                "Jump to related sessions, pipeline, and runs from the actions menu",
              ]}
              shortcuts={[{ keys: "⌘K", desc: "Open the command palette" }]}
            />
            <Menu align="right" items={moreItems} trigger={<IconButton icon="more" aria-label="Issue actions" />} />
          </span>
        }
      />
      <DetailLayout
        testId="issue-detail-layout"
        dataKey={issue.displayId}
        rail={
          <FactsRail>
            {standingQ.data ? <IssueStandingFacts row={standingQ.data} slug={slug} rail /> : null}
            <FactsGroup title="Properties" testId="facts-properties">
              {properties}
            </FactsGroup>
          </FactsRail>
        }
      >
        <DetailMobileTitle itemKey={issue.displayId} title={<span className="break-words">{issue.title}</span>} badge={badge} />
        <div className="grid gap-3 px-8 pt-4 empty:hidden max-md:px-4">
          {blocker && (
            <BlockerBanner
              blocker={blocker}
              slug={slug}
              pending={pending || !canWrite}
              onResumePark={onTransition}
              onResumeRun={onResumeRun}
              onProvideInfo={focusDecisions}
            />
          )}
          <DecisionPanel
            issueId={issue.id}
            parkedForInfo={issue.status === "needs_info"}
            threadQuestion={threadQuestion}
            onAnswerInThread={canWrite ? (text) => answerInThread.mutateAsync({ body: text }) : undefined}
          />
          <AwaitingReleaseBanner projectId={issue.projectId} issueId={issue.id} canWrite={canWrite} />
          {reasonDialog}
          {agentState && <LiveAgentPanel state={agentState} step={liveStep ?? "—"} slug={slug} issueId={id} />}
        </div>
        <DetailTabs tabs={tabs} value={tab} onChange={setTab} testId="issue-tabs" />
        <DetailPane label={tabs.find((t) => t.value === tab)?.label ?? "Overview"}>
          {tab === "overview" ? (
            <div className="grid gap-8" data-testid="view-overview">
              <ReleaseNoteCard issue={issue} />
              <DescriptionCard
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
          ) : null}
          {tab === "criteria" ? (
            <div data-testid="view-criteria">
              {hasCriteriaRows ? (
                <CriteriaList issueId={issue.id} />
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
          ) : null}
          {tab === "runs" ? (
            <div className="grid gap-6" data-testid="view-runs">
              {/* Session-group continuity (ISS-376) — resumed/fresh per step. Self-hides when no session carries group metadata. */}
              <SessionGroupTimeline sessions={issue.agentSessions ?? []} />
              {handoffsQ.isLoading || durationsQ.isLoading ? (
                <EmptyPanelLine title="Steps" status="Loading…" />
              ) : handoffsQ.isError || durationsQ.isError ? (
                <EmptyPanelLine
                  title="Steps"
                  status="Couldn't load"
                  detail={formatApiError(handoffsQ.isError ? handoffsQ.error : durationsQ.error)}
                />
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
                        onToggle={() => setExpandedStep((cur) => (cur === outcome.step ? null : outcome.step))}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          ) : null}
          {tab === "activity" ? (
            <section id="issue-comments" aria-label="Activity" data-testid="view-activity">
              <SegmentedControl
                options={[
                  { value: "comments", label: "Comments", count: commentsQ.data?.totalCount },
                  { value: "activity", label: "History", count: activityQ.data?.items.length },
                  { value: "tasks", label: "Tasks", count: tasksQ.data?.length },
                ]}
                value={thread}
                onChange={setThread}
              />
              <div className="mt-4">
                {thread === "comments" &&
                  (commentsQ.isLoading ? (
                    <TabLoading />
                  ) : commentsQ.isError ? (
                    <TabError query={commentsQ} what="comments" />
                  ) : (
                    <CommentThread issueId={issue.id} comments={commentsQ.data?.items ?? []} members={membersQ.data} readOnly={!canWrite} />
                  ))}
                {thread === "activity" &&
                  (activityQ.isLoading ? (
                    <TabLoading />
                  ) : activityQ.isError ? (
                    <TabError query={activityQ} what="history" />
                  ) : (
                    <ActivityFeed items={activityQ.data?.items ?? []} />
                  ))}
                {thread === "tasks" &&
                  (tasksQ.isLoading ? (
                    <TabLoading />
                  ) : tasksQ.isError ? (
                    <TabError query={tasksQ} what="tasks" />
                  ) : (tasksQ.data?.length ?? 0) === 0 ? (
                    <EmptyState title="No tasks" message="This issue has no sub-tasks." mascot={false} />
                  ) : (
                    <ul className="border-t border-line-subtle">
                      {tasksQ.data?.map((t) => (
                        <li key={t.id} className="flex items-center justify-between gap-3 border-b border-line-subtle py-2">
                          <span className="fg-body-sm min-w-0 truncate text-fg">{t.title}</span>
                          <Badge tone={TASK_STATUS_TONE[t.status]}>{TASK_STATUS_LABELS[t.status]}</Badge>
                        </li>
                      ))}
                    </ul>
                  ))}
              </div>
            </section>
          ) : null}
        </DetailPane>
      </DetailLayout>

      <ModulePicker
        open={modulePickerOpen}
        onClose={() => setModulePickerOpen(false)}
        issueId={issue.id}
        projectId={projectId}
        slug={slug}
        labels={issue.labels ?? []}
      />
    </div>
  );
}

const ISSUE_TABS = ["overview", "criteria", "runs", "activity"] as const;

/** A heading inside a tab: primary colour, 15/600, so it is never mistaken for a label. */
function ViewHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-15 font-semibold leading-snug text-fg">{children}</h2>;
}

/** Skeleton placeholder for the detail tab bodies (comments / activity / tasks)
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

/** Pick the agent session to surface in the live-agent panel: a running one
 *  wins, else a queued one. Returns null when none is active (no false signal). */
function pickActiveSession(
  sessions: IssueAgentSession[] | undefined,
): IssueAgentSession | null {
  if (!sessions || sessions.length === 0) return null;
  return (
    sessions.find((s) => s.status === "running") ??
    sessions.find((s) => s.status === "queued") ??
    null
  );
}
