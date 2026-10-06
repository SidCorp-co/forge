"use client";

// web-v2 Issue detail (`/projects/[slug]/issues/[id]`, ISS-294): the shared DetailHeader in the top
// bar (back to the list view it came from, key, title, status, one primary action), whose turn as
// banners, then Overview / Criteria / Runs / Activity as tabs (`?tab=`) beside a sticky facts rail —
// the read model's standing over the editable properties. Live via WS on the keys `['issue',id]` /
// `['comments',id]` / `['activities',id]` and `['issues','standing']` — the event-router invalidates
// exactly those, so a query keyed anything else here stops updating and nothing reports it.

import {
  DetailHeader,
  DetailLayout,
  DetailMobileTitle,
  DetailPane,
  DetailTabs,
  ErrorState,
  FactsGroup,
  FactsRail,
  ProjectLoader,
  StatusBadge,
  StatusChip,
  useListOrigin,
  useUrlTab,
} from "@/design";
import { useResumeRun } from "@/features/run-control/hooks";
import { DecisionPanel, focusDecisionPanel } from "@/features/questions/components/decision-panel";
import { useRecents } from "@/lib/navigation/recents";
import { useIssueProject } from "./use-issue-project";
import { MockupsPanel } from "@/features/mockups/components/mockups-panel";
import { useMockups } from "@/features/mockups/hooks";
import type { MockupTarget } from "@/features/mockups/types";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalIssueId,
  isLiveRun,
  issueQueryKey,
  parseChecklist,
  runStatusChip,
  workStepOf,
} from "../derive";
import { useCriteria } from "../criteria";
import { deriveQueuedStep } from "../waiting";
import {
  useActivity,
  useAttachments,
  useComments,
  useCreateComment,
  useIssue,
} from "../detail-hooks";
import {
  useIssueCost,
  useIssueDeps,
  useIssueStandingOf,
  usePatchIssue,
  useProjectMembers,
} from "../hooks";
import { ISSUES_LIST, issuesHref } from "@/lib/routes/issues";
import { ReleaseApprovalProvider } from "../release-approval";
import { IssueBanner, IssueStandingFacts } from "./issue-standing-bits";
import { useIssuePark } from "../park";
import type { IssueAgentSession, IssueStatus } from "../types";
import { AwaitingReleaseBanner } from "./awaiting-release-banner";
import { BlockerBanner } from "./blocker-banner";
import { useGuardedTransition } from "./use-guarded-transition";
import { type LiveAgentState, LiveAgentPanel } from "./live-agent-panel";
import { ModulePicker } from "./module-picker";
import { PropertiesRail } from "./properties-rail";
import { readStart } from "./start-issue-action";
import { IssueActions } from "./detail/issue-actions";
import {
  ActivityTab,
  type ActivityThread,
  CriteriaTab,
  ISSUE_TABS,
  OverviewTab,
  RunsTab,
} from "./detail/issue-tabs";

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
  const [tab, setTab] = useUrlTab(ISSUE_TABS);
  const back = useListOrigin(ISSUES_LIST, issuesHref(slug));

  useRoom(projectRoom(projectId));

  const { projectRole, canWrite, policyQ } = useIssueProject(projectId);
  const [modulePickerOpen, setModulePickerOpen] = useState(false);

  // ISS-1160 — `id` off the URL is the display key as often as the row uuid;
  // `projectId` (already resolved from the route's slug) is what lets it
  // resolve on every one of these reads.
  const issueQ = useIssue(id, projectId);
  const mockupTarget = { type: "issue" as const, key: issueQ.data?.displayId ?? id };
  const mockupsQ = useMockups(projectId, mockupTarget);
  const canonicalId = canonicalIssueId(id, issueQ.data?.id);
  const commentsQ = useComments(canonicalId, projectId);
  const depsQ = useIssueDeps(canonicalId, true, projectId);
  const costQ = useIssueCost(canonicalId, true, projectId);

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
  const checklist = useMemo(() => keyedChecklist(issue?.acceptanceCriteria), [issue?.acceptanceCriteria]);
  const criteriaQ = useCriteria(issue?.id);
  const hasCriteriaRows = (criteriaQ.data?.criteria.length ?? 0) > 0;
  useRememberIssue(id, slug, issue?.displayId, issue?.title);

  if (issueQ.isLoading || issueQ.isError || !issue) return <IssueUnread query={issueQ} />;

  const onTransition = (toStatus: IssueStatus) =>
    requestTransition(issue.id, toStatus, { onSuccess: refreshIssue });
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) =>
    patch.mutate({ id: issue.id, body }, { onSuccess: refreshIssue });

  const blocker = standingQ.data?.blocker ?? null;
  const liveStep = issue.pipelineHealth?.activeSession?.skill ?? null;
  const stepOutcomes = standingQ.data?.stepOutcomes ?? [];
  const agentState = liveAgentState(issue.agentSessions, issue.pipelineHealth);

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
  const threadQuestion = park.state === "ready" && park.park ? park.park.threadQuestion : null;

  // The moves the issue machine draws from this status.
  const moves = standingQ.data?.standing.moves ?? [];
  // The run's state is a session chip beside the issue's lifecycle chip, never merged into it (ISS-360, ISS-1150).
  const runChip = runStatusChip(issue);
  const isRunActive = isLiveRun(runChip) || issue.status === "in_progress" || issue.status === "reopen";
  const start = readStart({
    status: issue.status,
    policy: policyQ.data,
    policyError: policyQ.error,
    role: projectRole,
    sessionContext: issue.sessionContext,
  });

  const tabs = [
    { value: "overview" as const, label: "Overview" },
    { value: "criteria" as const, label: "Criteria", count: criteriaQ.data?.criteria.length ?? checklist.length },
    { value: "runs" as const, label: "Runs", count: stepOutcomes.length },
    { value: "mockups" as const, label: "Mockups", count: mockupsQ.data?.returned },
    { value: "activity" as const, label: "Activity", count: commentsQ.data?.totalCount },
  ];

  const badge = (
    <>
      <StatusBadge family="issue" value={issue.status} step={workStepOf(issue)} tone={standingQ.data?.standing.tone} />
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
      moves={moves}
    />
  );

  return (
    <ReleaseApprovalProvider value={standingQ.data?.releaseApproval}>
    <div className="min-h-full bg-app" ref={stickyHeader} data-testid="issue-detail">
      <DetailHeader
        back={{ href: back, label: "Issues" }}
        itemKey={issue.displayId}
        keyTitle={issue.id}
        title={issue.title}
        badge={badge}
        action={
          <IssueActions
            issue={issue}
            slug={slug}
            linkId={id}
            canWrite={canWrite}
            pending={pending}
            start={start}
            isRunActive={isRunActive}
            exitsHere={moves.map((m) => m.to)}
            onTransition={onTransition}
            onStarted={refreshIssue}
          />
        }
      />
      <DetailLayout
        testId="issue-detail-layout"
        dataKey={issue.displayId}
        rail={
          <FactsRail>
            {standingQ.data ? <IssueStandingFacts row={standingQ.data} slug={slug} /> : null}
            <FactsGroup title="Properties" testId="facts-properties">
              {properties}
            </FactsGroup>
          </FactsRail>
        }
      >
        <DetailMobileTitle itemKey={issue.displayId} title={<span className="break-words">{issue.title}</span>} badge={badge} />
        <div className="grid gap-3 px-8 pt-4 empty:hidden max-md:px-4">
          {!blocker && standingQ.data ? <IssueBanner standing={standingQ.data.standing} className="rounded-md" /> : null}
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
          <IssueTabBody
            tab={tab}
            issue={issue}
            canonicalId={canonicalId}
            projectId={projectId}
            canWrite={canWrite}
            criteria={{ hasCriteriaRows, checklist }}
            standingQ={standingQ}
            commentsQ={commentsQ}
            mockupTarget={mockupTarget}
          />
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
    </ReleaseApprovalProvider>
  );
}

function IssueTabBody({
  tab,
  issue,
  canonicalId,
  projectId,
  canWrite,
  criteria,
  standingQ,
  commentsQ,
  mockupTarget,
}: {
  tab: (typeof ISSUE_TABS)[number];
  issue: NonNullable<ReturnType<typeof useIssue>["data"]>;
  canonicalId: string | undefined;
  projectId: string;
  canWrite: boolean;
  criteria: { hasCriteriaRows: boolean; checklist: ReturnType<typeof keyedChecklist> };
  standingQ: ReturnType<typeof useIssueStandingOf>;
  commentsQ: ReturnType<typeof useComments>;
  mockupTarget: MockupTarget;
}) {
  const [thread, setThread] = useState<ActivityThread>("comments");
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const activityQ = useActivity(canonicalId, projectId);
  const attachmentsQ = useAttachments(canonicalId, projectId);
  const membersQ = useProjectMembers(projectId);
  return (
    <>
      {tab === "overview" ? (
        <OverviewTab issue={issue} attachmentsQ={attachmentsQ} canWrite={canWrite} />
      ) : null}
      {tab === "criteria" ? (
        <CriteriaTab issueId={issue.id} hasCriteriaRows={criteria.hasCriteriaRows} checklist={criteria.checklist} />
      ) : null}
      {tab === "runs" ? (
        <RunsTab
          sessions={issue.agentSessions ?? []}
          standingQ={standingQ}
          stepOutcomes={standingQ.data?.stepOutcomes ?? []}
          expandedStep={expandedStep}
          onToggleStep={(step) => setExpandedStep((cur) => (cur === step ? null : step))}
        />
      ) : null}
      {tab === "mockups" ? <MockupsPanel projectId={projectId} target={mockupTarget} /> : null}
      {tab === "activity" ? (
        <ActivityTab
          issueId={issue.id}
          thread={thread}
          onThread={setThread}
          commentsQ={commentsQ}
          activityQ={activityQ}
          members={membersQ.data}
          canWrite={canWrite}
        />
      ) : null}
    </>
  );
}

function keyedChecklist(acceptanceCriteria: string | null | undefined) {
  const counts = new Map<string, number>();
  return parseChecklist(acceptanceCriteria).map((item) => {
    const count = counts.get(item.text) ?? 0;
    counts.set(item.text, count + 1);
    return { ...item, key: `${item.text}-${count}` };
  });
}

function useRememberIssue(id: string, slug: string, displayId: string | undefined, title: string | undefined) {
  const { push } = useRecents();
  useEffect(() => {
    if (!displayId || !title) return;
    push({ kind: "issue", id, label: `${displayId} · ${title}`, href: `/projects/${slug}/issues/${id}`, icon: "list" });
  }, [displayId, title, id, slug, push]);
}

function IssueUnread({ query }: { query: ReturnType<typeof useIssue> }) {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      {query.isLoading ? (
        <ProjectLoader label="loading issue…" />
      ) : (
        <ErrorState
          title="Couldn't load issue"
          message={formatApiError(query.error)}
          onRetry={isRetryableApiError(query.error) ? () => query.refetch() : undefined}
        />
      )}
    </div>
  );
}

function liveAgentState(
  sessions: IssueAgentSession[] | undefined,
  health: Parameters<typeof deriveQueuedStep>[0],
): LiveAgentState | null {
  const live = pickActiveSession(sessions);
  if (live) return { kind: "live", session: live };
  const queued = deriveQueuedStep(health, false);
  return queued ? { kind: "queued", step: queued } : null;
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
