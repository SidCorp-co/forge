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
  useListOrigin,
  useRecordView,
} from "@/design";
import { useResumeRun } from "@/features/run-control";
import { focusIssueQuestions } from "@/features/questions";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRecents } from "@/lib/navigation/recents";
import { useIssueProject } from "./use-issue-project";
import { useIssueReads } from "./use-issue-reads";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { isLiveRun, issueQueryKey, parseChecklist, runStatusChip } from "../derive";
import { deriveQueuedStep } from "../waiting";
import { useActivity, useAttachments, type useIssue, useCreateComment } from "../detail-hooks";
import { usePatchIssue, useProjectMembers } from "../hooks";
import { ISSUES_LIST, issuesHref } from "@/lib/routes/issues";
import { ReleaseApprovalProvider } from "../release-approval";
import type { IssueAgentSession, IssueStatus } from "../types";
import { ReleaseNowAct } from "./awaiting-release-banner";
import { BlockerAct, } from "./blocker-banner";
import { useGuardedTransition } from "./use-guarded-transition";
import type { LiveAgentState, } from "./live-agent";
import { ModulePicker } from "./module-picker";
import { PropertiesRail } from "./properties-rail";
import { readStart } from "./start-issue-action";
import { StatusEdit } from "./inline-edit-cell";
import { IssueActions } from "./detail/issue-actions";
import { IssuePageMain } from "./detail/issue-page-main";
import { Written } from "@/lib/i18n/written";

interface IssueDetailScreenProps {
  projectId: string;
  slug: string;
  id: string;
}

export function IssueDetailScreen({ projectId, slug, id }: IssueDetailScreenProps) {
  const [view, setView] = useRecordView();
  const developer = view === "developer";
  const back = useListOrigin(ISSUES_LIST, issuesHref(slug));

  useRoom(projectRoom(projectId));

  const { projectRole, canWrite, policyQ } = useIssueProject(projectId);
  const [modulePickerOpen, setModulePickerOpen] = useState(false);

  const { issueQ, mockupTarget, mockupsQ, canonicalId, switching, commentsQ, depsQ, costQ, standingQ, park } =
    useIssueReads(id, projectId);

  const patch = usePatchIssue();
  const { requestTransition, requestParkLeave, dialog: reasonDialog, isPending: transitionPending } = useGuardedTransition();
  const resumeRun = useResumeRun();
  const refreshIssue = useRefreshIssue(id, projectId, issueQ.data?.id);
  const onResumeRun = (runId: string) => resumeRun.mutate(runId, { onSuccess: refreshIssue });
  const pending = patch.isPending || transitionPending || resumeRun.isPending;

  const issue = issueQ.data;
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  const answerInThread = useCreateComment(issue?.id ?? "");
  const attachmentsQ = useAttachments(canonicalId, projectId);
  const activityQ = useActivity(canonicalId, projectId);
  const membersQ = useProjectMembers(projectId);
  const checklist = keyedChecklist(issue?.acceptanceCriteria);
  useRememberIssue(id, slug, issue?.displayId, issue?.title);

  if (issueQ.isLoading || issueQ.isError || !issue) return <IssueUnread query={issueQ} />;
  if (switching) return <IssueUnread query={issueQ} switching />;

  const onTransition = (toStatus: IssueStatus) => requestTransition(issue, toStatus, { onSuccess: refreshIssue });
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) =>
    patch.mutate({ id: issue.id, body }, { onSuccess: refreshIssue });

  const blocker = standingQ.data?.blocker ?? null;
  const liveStep = issue.pipelineHealth?.activeSession?.skill ?? null;
  const agentState = liveAgentState(issue.agentSessions, issue.pipelineHealth);

  const focusDecisions = () => {
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => focusIssueQuestions(stickyHeaderRef.current));
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
  const start = readStart({ status: issue.status, policy: policyQ.data, policyError: policyQ.error, role: projectRole, sessionContext: issue.sessionContext });

  // The status, once, in the top bar, as the control that moves it: the run is not a second chip, and
  // the step is the stepper's under Now, so the chip does not say it too (REQ-43 BC-5).
  const badge = (
    <StatusEdit
      status={issue.status}
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
      <div className="min-h-full bg-app" ref={stickyHeaderRef} data-testid="issue-detail" data-view={view}>
        <IssueHeader
          issue={issue}
          slug={slug}
          linkId={id}
          back={back}
          badge={badge}
          canWrite={canWrite}
          pending={pending}
          start={start}
          isRunActive={isRunActive}
          exitsHere={moves.map((m) => m.to)}
          onTransition={onTransition}
          onStarted={refreshIssue}
        />
        <DetailLayout
          testId="issue-detail-layout"
          dataKey={issue.displayId}
          rail={
            <IssueRail
              issue={issue}
              slug={slug}
              costQ={costQ}
              depsQ={depsQ}
              standingQ={standingQ}
              pending={pending}
              canWrite={canWrite}
              developer={developer}
              onPatch={onPatch}
              onEditModules={() => setModulePickerOpen(true)}
            />
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
            mockupTarget={mockupTarget}
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
    <div className="grid min-h-128 place-items-center">
      {query.isLoading || switching ? (
        <ProjectLoader label={t("issues.detail.loading")} />
      ) : (
        <ErrorState
          title={t("issues.detail.loadFailed")}
          message={formatApiError(query.error)}
          onRetry={isRetryableApiError(query.error) ? () => void query.refetch() : undefined}
        />
      )}
    </div>
  );
}

/** The live-agent panel's subject: a running session, else a queued one, else the step queued with no session yet. */
function liveAgentState(sessions: IssueAgentSession[] | undefined, health: Parameters<typeof deriveQueuedStep>[0]): LiveAgentState | null {
  const live = sessions?.find((s) => s.status === "running") ?? sessions?.find((s) => s.status === "queued");
  if (live) return { kind: "live", session: live };
  const queued = deriveQueuedStep(health, false);
  return queued ? { kind: "queued", step: queued } : null;
}

/** The properties rail beside the page: the issue's fields, edges and, for a developer, its engineering facts. */
function IssueRail({
  issue,
  slug,
  costQ,
  depsQ,
  standingQ,
  pending,
  canWrite,
  developer,
  onPatch,
  onEditModules,
}: {
  issue: NonNullable<ReturnType<typeof useIssueReads>["issueQ"]["data"]>;
  slug: string;
  costQ: ReturnType<typeof useIssueReads>["costQ"];
  depsQ: ReturnType<typeof useIssueReads>["depsQ"];
  standingQ: ReturnType<typeof useIssueReads>["standingQ"];
  pending: boolean;
  canWrite: boolean;
  developer: boolean;
  onPatch: ComponentProps<typeof PropertiesRail>["onPatch"];
  onEditModules: () => void;
}) {
  const standing = standingQ.data;
  return (
    <FactsRail>
      <PropertiesRail
        issue={issue}
        slug={slug}
        cost={costQ.data}
        deps={depsQ.data}
        pending={pending}
        readOnly={!canWrite}
        onPatch={onPatch}
        onEditModules={canWrite ? onEditModules : undefined}
        canMarkMerged={canWrite}
        requirementKey={standing ? (standing.standing.requirement?.key ?? null) : undefined}
        owner={standing?.standing.owner ?? null}
        standing={standing?.standing}
        developer={developer}
      />
    </FactsRail>
  );
}

/** The page's header: back to the list, key and title, the status control and the issue's acts. */
function IssueHeader({ back, badge, ...acts }: ComponentProps<typeof IssueActions> & { back: string; badge: ReactNode }) {
  const t = useCopy();
  const { issue } = acts;
  return (
    <DetailHeader
      back={{ href: back, label: t("issues.screen.title") }}
      itemKey={issue.displayId}
      keyTitle={issue.id}
      title={<Written text={issue.title} lang={issue.writtenLang} />}
      badge={badge}
      action={<IssueActions {...acts} />}
    />
  );
}

/**
 * Refresh the issue after a write. ISS-1160 — a display-key load keys `useIssue` on `id`+`projectId`
 * (never globally unique on `id` alone), so an invalidation naming only the canonical uuid a mutation
 * reports misses that entry; name both.
 */
function useRefreshIssue(id: string, projectId: string, canonicalId: string | undefined) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["issue", canonicalId ?? id] });
    void qc.invalidateQueries({ queryKey: issueQueryKey(id, projectId) });
  };
}
