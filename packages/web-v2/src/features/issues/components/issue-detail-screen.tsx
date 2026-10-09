"use client";

// web-v2 Issue detail (`/projects/[slug]/issues/[id]`, ISS-294; REQ-43): the page reads as state, not
// prose. The shared DetailHeader in the top bar (back to the list view it came from, key, title, the
// status with its moves, one primary action), then Now / Needs you / Done by over a stepper, the
// criteria as one-line rows, the live preview as one row, the change in one line, and the Details
// as folded rows, beside a facts rail of properties and relations. `?view=developer` opens every
// fold and draws what only a developer reads: the blocker's reasoning, the live agent, runs, mockups.
// Live via WS on the keys `['issue',id]` / `['comments',id]` / `['activities',id]` and
// `['issues','standing']` — the event-router invalidates exactly those, so a query keyed anything
// else here stops updating and nothing reports it.

import {
  DetailHeader,
  DetailLayout,
  DetailMobileTitle,
  ErrorState,
  FactsRail,
  ProjectLoader,
  SegmentedControl,
  useListOrigin,
  useUrlChoice,
} from "@/design";
import { useResumeRun } from "@/features/run-control/hooks";
import { DecisionPanel, focusDecisionPanel } from "@/features/questions/components/decision-panel";
import { PreviewPanel } from "@/features/previews/preview-panel";
import { settingsHref } from "@/features/project-settings/sections";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRecents } from "@/lib/navigation/recents";
import { useIssueProject } from "./use-issue-project";
import { useIssueReads } from "./use-issue-reads";
import type { MockupTarget } from "@/features/mockups/types";
import { useIssueForecast } from "@/features/forecast/hooks";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useQueryClient } from "@tanstack/react-query";
import type { ParkThreadQuestion } from "@forge/contracts/park";
import type { Forecast } from "@forge/contracts/forecast";
import type { IssueBlocker } from "@forge/contracts/issue-standing";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isLiveRun, issueQueryKey, parseChecklist, runStatusChip, workStepOf } from "../derive";
import { deriveQueuedStep } from "../waiting";
import { useActivity, useAttachments, type useComments, type useIssue, useCreateComment } from "../detail-hooks";
import { type useIssueStandingOf, usePatchIssue, useProjectMembers } from "../hooks";
import { ISSUES_LIST, issuesHref } from "@/lib/routes/issues";
import { ReleaseApprovalProvider } from "../release-approval";
import type { IssueAgentSession, IssueDetail, IssueStatus } from "../types";
import { AwaitingReleaseBanner, ReleaseNowAct } from "./awaiting-release-banner";
import { PatternsPanel } from "./patterns-panel";
import { BlockerAct, BlockerBanner } from "./blocker-banner";
import { useGuardedTransition } from "./use-guarded-transition";
import { type LiveAgentState, LiveAgentPanel } from "./live-agent-panel";
import { ModulePicker } from "./module-picker";
import { PropertiesRail } from "./properties-rail";
import { readStart } from "./start-issue-action";
import { StatusEdit } from "./inline-edit-cell";
import { IssueActions } from "./detail/issue-actions";
import { IssueDetails } from "./detail/issue-details";
import { IssueStateHead } from "./detail/issue-state-head";
import { ChangesRow } from "./changes-row";
import { CriteriaSection } from "./criteria-section";
import { Written } from "@/lib/i18n/written";

/** The two ways to read the page: a person's, and a developer's with every fold open. */
const ISSUE_PAGE_VIEWS = ["person", "developer"] as const;
type IssuePageView = (typeof ISSUE_PAGE_VIEWS)[number];

interface IssueDetailScreenProps {
  projectId: string;
  slug: string;
  id: string;
}

export function IssueDetailScreen({ projectId, slug, id }: IssueDetailScreenProps) {
  const [view, setView] = useUrlChoice<IssuePageView>("view", ISSUE_PAGE_VIEWS, "person");
  const developer = view === "developer";
  const t = useCopy();
  const back = useListOrigin(ISSUES_LIST, issuesHref(slug));

  useRoom(projectRoom(projectId));

  const { projectRole, canWrite, policyQ } = useIssueProject(projectId);
  const [modulePickerOpen, setModulePickerOpen] = useState(false);

  const { issueQ, mockupTarget, mockupsQ, canonicalId, switching, commentsQ, depsQ, costQ, standingQ, park } =
    useIssueReads(id, projectId);

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
  const onResumeRun = (runId: string) => resumeRun.mutate(runId, { onSuccess: refreshIssue });
  const pending = patch.isPending || transitionPending || resumeRun.isPending;

  const issue = issueQ.data;
  const stickyHeader = useRef<HTMLDivElement>(null);
  const answerInThread = useCreateComment(issue?.id ?? "");
  const forecastQ = useIssueForecast(issue?.projectId, issue?.displayId);
  const attachmentsQ = useAttachments(canonicalId, projectId);
  const activityQ = useActivity(canonicalId, projectId);
  const membersQ = useProjectMembers(projectId);
  const checklist = useMemo(() => keyedChecklist(issue?.acceptanceCriteria), [issue?.acceptanceCriteria]);
  useRememberIssue(id, slug, issue?.displayId, issue?.title);

  if (issueQ.isLoading || issueQ.isError || !issue) return <IssueUnread query={issueQ} />;
  if (switching) return <IssueUnread query={issueQ} switching />;

  const onTransition = (toStatus: IssueStatus) => requestTransition(issue.id, toStatus, { onSuccess: refreshIssue });
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) => patch.mutate({ id: issue.id, body }, { onSuccess: refreshIssue });

  const blocker = standingQ.data?.blocker ?? null;
  const liveStep = issue.pipelineHealth?.activeSession?.skill ?? null;
  const agentState = liveAgentState(issue.agentSessions, issue.pipelineHealth);

  const focusDecisions = () => {
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => focusDecisionPanel(stickyHeader.current));
    }
  };

  const parkActions = {
    answer: focusDecisions,
    move: onTransition,
    notNeeded: (at: IssueStatus) => requestParkLeave(issue.id, "not_needed", [at], { onSuccess: refreshIssue }),
    moveAnyway: (targets: IssueStatus[]) => requestParkLeave(issue.id, "move_anyway", targets, { onSuccess: refreshIssue }),
  };
  const statusPark = canWrite ? { reading: park, actions: parkActions } : undefined;
  const threadQuestion = park.state === "ready" && park.park ? park.park.threadQuestion : null;

  // The moves the issue machine draws from this status.
  const moves = standingQ.data?.standing.moves ?? [];
  const isRunActive = isLiveRun(runStatusChip(issue)) || issue.status === "in_progress" || issue.status === "reopen";
  const start = readStart({
    status: issue.status,
    policy: policyQ.data,
    policyError: policyQ.error,
    role: projectRole,
    sessionContext: issue.sessionContext,
  });

  // The status, once, in the top bar, as the control that moves it: the run is not a second chip.
  const badge = (
    <StatusEdit
      status={issue.status}
      step={workStepOf(issue)}
      moves={moves}
      agentStatus={issue.agentStatus}
      disabled={pending || !canWrite}
      onTransition={onTransition}
      park={statusPark}
    />
  );

  const needsYouAct = (
    <>
      {blocker ? (
        <BlockerAct blocker={blocker} pending={pending || !canWrite} onResumePark={onTransition} onResumeRun={onResumeRun} onProvideInfo={focusDecisions} />
      ) : null}
      <ReleaseNowAct projectId={issue.projectId} issueId={issue.id} canWrite={canWrite} />
    </>
  );

  return (
    <ReleaseApprovalProvider value={standingQ.data?.releaseApproval}>
      <div className="min-h-full bg-app" ref={stickyHeader} data-testid="issue-detail" data-view={view}>
        <DetailHeader
          back={{ href: back, label: t("issues.screen.title") }}
          itemKey={issue.displayId}
          keyTitle={issue.id}
          title={<Written text={issue.title} lang={issue.writtenLang} />}
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
              <PropertiesRail
                issue={issue}
                slug={slug}
                cost={costQ.data}
                deps={depsQ.data}
                pending={pending}
                readOnly={!canWrite}
                onPatch={onPatch}
                onEditModules={canWrite ? () => setModulePickerOpen(true) : undefined}
                canMarkMerged={canWrite}
                requirementKey={standingQ.data ? (standingQ.data.standing.requirement?.key ?? null) : undefined}
                owner={standingQ.data?.standing.owner ?? null}
                developer={developer}
              />
            </FactsRail>
          }
        >
          <DetailMobileTitle itemKey={issue.displayId} title={<Written className="break-words" text={issue.title} lang={issue.writtenLang} />} badge={badge} />
          <IssuePageMain
            issue={issue}
            projectId={projectId}
            slug={slug}
            id={id}
            canWrite={canWrite}
            pending={pending}
            view={view}
            onView={setView}
            standingQ={standingQ}
            blocker={blocker}
            forecast={forecastQ.data?.forecast}
            needsYouAct={needsYouAct}
            threadQuestion={threadQuestion}
            onAnswerInThread={canWrite ? (text) => answerInThread.mutateAsync({ body: text }) : undefined}
            onTransition={onTransition}
            onResumeRun={onResumeRun}
            onProvideInfo={focusDecisions}
            agentState={agentState}
            liveStep={liveStep}
            attachmentsQ={attachmentsQ}
            commentsQ={commentsQ}
            activityQ={activityQ}
            membersQ={membersQ}
            mockupTarget={mockupTarget as MockupTarget}
            mockupCount={mockupsQ.data?.returned}
            checklist={checklist}
            reasonDialog={reasonDialog}
          />
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

/** The main column of the page: the state head, what needs a person, the criteria, the preview, the change and the Details. */
function IssuePageMain(props: {
  issue: IssueDetail;
  projectId: string;
  slug: string;
  id: string;
  canWrite: boolean;
  pending: boolean;
  view: IssuePageView;
  onView: (view: IssuePageView) => void;
  standingQ: ReturnType<typeof useIssueStandingOf>;
  blocker: IssueBlocker | null;
  forecast: Forecast | undefined;
  needsYouAct: ReactNode;
  threadQuestion: ParkThreadQuestion | null;
  onAnswerInThread: ((text: string) => Promise<unknown>) | undefined;
  onTransition: (to: IssueStatus) => void;
  onResumeRun: (runId: string) => void;
  onProvideInfo: () => void;
  agentState: LiveAgentState | null;
  liveStep: string | null;
  attachmentsQ: ReturnType<typeof useAttachments>;
  commentsQ: ReturnType<typeof useComments>;
  activityQ: ReturnType<typeof useActivity>;
  membersQ: ReturnType<typeof useProjectMembers>;
  mockupTarget: MockupTarget;
  mockupCount: number | undefined;
  checklist: { key: string; text: string; checked: boolean }[];
  reasonDialog: ReactNode;
}) {
  const { issue, projectId, slug, id, canWrite, pending, view, standingQ, blocker, agentState, liveStep } = props;
  const t = useCopy();
  const developer = view === "developer";
  const standing = standingQ.data?.standing;
  return (
          <div className="max-w-[900px] px-8 pb-16 pt-5 max-md:px-4" data-testid="issue-page-main">
            <div className="mb-3 flex justify-end" data-testid="issue-view-switch">
              <SegmentedControl
                options={ISSUE_PAGE_VIEWS.map((v) => ({ value: v, label: t(`issues.view.${v}`) }))}
                value={view}
                onChange={props.onView}
              />
            </div>
            <div data-highlight="waiting question">
              {standing ? <IssueStateHead standing={standing} forecast={props.forecast} act={props.needsYouAct} /> : null}
            </div>
            <div className="grid gap-3 empty:hidden" data-testid="issue-needs-you-panels">
              <DecisionPanel
                show="now"
                issueId={issue.id}
                parkedForInfo={issue.status === "needs_info"}
                threadQuestion={props.threadQuestion}
                onAnswerInThread={props.onAnswerInThread}
              />
              <PatternsPanel issueId={issue.id} projectId={issue.projectId} />
              {props.reasonDialog}
            </div>
            {developer && blocker ? (
              <div className="mt-3">
                <BlockerBanner
                  blocker={blocker}
                  slug={slug}
                  pending={pending || !canWrite}
                  onResumePark={props.onTransition}
                  onResumeRun={props.onResumeRun}
                  onProvideInfo={props.onProvideInfo}
                />
              </div>
            ) : null}
            {developer ? <AwaitingReleaseBanner projectId={issue.projectId} issueId={issue.id} canWrite={canWrite} /> : null}
            {developer && agentState ? <LiveAgentPanel state={agentState} step={liveStep ?? "—"} slug={slug} issueId={id} /> : null}
            <div className="border-b border-line-subtle py-4">
              <CriteriaSection
                issue={issue}
                projectId={projectId}
                checklist={props.checklist}
                canWrite={canWrite}
                requirementKey={standingQ.data?.standing.requirement?.key ?? null}
              />
            </div>
            <div className="border-b border-line-subtle py-4" data-highlight="preview">
              <PreviewPanel
                issueId={issue.id}
                issueLabel={issue.displayId}
                canWrite={canWrite}
                settingsHref={settingsHref(slug, "preview")}
                hasLiveRun={(issue.agentSessions ?? []).some((s) => s.status === "running")}
                row={!developer}
              />
            </div>
            <ChangesRow issue={issue} slug={slug} developer={developer} />
            <div className="pt-4">
              <IssueDetails
                key={view}
                issue={issue}
                projectId={projectId}
                slug={slug}
                canWrite={canWrite}
                developer={developer}
                attachmentsQ={props.attachmentsQ}
                commentsQ={props.commentsQ}
                activityQ={props.activityQ}
                membersQ={props.membersQ}
                standingQ={standingQ}
                mockupTarget={props.mockupTarget}
                mockupCount={props.mockupCount}
              />
            </div>
          </div>
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

function IssueUnread({ query, switching = false }: { query: ReturnType<typeof useIssue>; switching?: boolean }) {
  const t = useCopy();
  return (
    <div className="grid min-h-[60vh] place-items-center">
      {query.isLoading || switching ? (
        <ProjectLoader label={t("issues.detail.loading")} />
      ) : (
        <ErrorState
          title={t("issues.detail.loadFailed")}
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
