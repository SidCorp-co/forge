
// web-v2 Issue detail (`/projects/[slug]/issues/[id]`, ISS-294; REQ-43): the page reads as state, not
// prose. The shared DetailHeader in the top bar (back to the list view it came from, key, title, the
// status as a chip), then Now / Done by over a stepper, the
// criteria as one-line rows, the live preview as one row, the change in one line, and the Details
// as folded rows, beside a facts rail of properties and relations. `?view=developer` opens every
// fold and draws what only a developer reads: the blocker's reasoning, the live agent, runs, mockups.
// A person never works an issue (REQ-68 BC-6, ISS-687): the page offers no move, pause, resume, run or
// release of it; what an issue owes a person is asked as a decision on its item, in Needs you.
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
  StatusBadge,
  useListOrigin,
  useRecordView,
} from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRecents } from "@/lib/navigation/recents";
import { useIssueProject } from "./use-issue-project";
import { useIssueReads } from "./use-issue-reads";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { isLiveRun, issueQueryKey, parseChecklist, runStatusChip } from "../derive";
import { deriveQueuedStep } from "../waiting";
import { useActivity, useAttachments, type useIssue, useCreateComment } from "../detail-hooks";
import { usePatchIssue, useProjectMembers } from "../hooks";
import { ISSUES_LIST, issuesHref } from "@/lib/routes/issues";
import { ReleaseApprovalProvider, useStatusTone } from "../release-approval";
import type { IssueAgentSession, IssueStatus } from "../types";
import type { LiveAgentState, } from "./live-agent";
import { ModulePicker } from "./module-picker";
import { PropertiesRail } from "./properties-rail";
import { readStart } from "./start-issue-action";
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
  const refreshIssue = useRefreshIssue(id, projectId, issueQ.data?.id);
  const pending = patch.isPending;

  const issue = issueQ.data;
  const answerInThread = useCreateComment(issue?.id ?? "");
  const attachmentsQ = useAttachments(canonicalId, projectId);
  const activityQ = useActivity(canonicalId, projectId);
  const membersQ = useProjectMembers(projectId);
  const checklist = keyedChecklist(issue?.acceptanceCriteria);
  useRememberIssue(id, slug, issue?.displayId, issue?.title);

  if (issueQ.isLoading || issueQ.isError || !issue) return <IssueUnread query={issueQ} />;
  if (switching) return <IssueUnread query={issueQ} switching />;

  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) =>
    patch.mutate({ id: issue.id, body }, { onSuccess: refreshIssue });

  const blocker = standingQ.data?.blocker ?? null;
  const liveStep = issue.pipelineHealth?.activeSession?.skill ?? null;
  const agentState = liveAgentState(issue.agentSessions, issue.pipelineHealth);

  const threadQuestion = park.state === "ready" && park.park ? park.park.threadQuestion : null;

  const isRunActive = isLiveRun(runStatusChip(issue)) || issue.status === "in_progress" || issue.status === "reopen";
  const start = readStart({ status: issue.status, policy: policyQ.data, policyError: policyQ.error, role: projectRole, sessionContext: issue.sessionContext });

  // The status, once, in the top bar, as a chip that moves nothing (REQ-68 BC-6): the run is not a
  // second chip, and the step is the stepper's under Now, so the chip does not say it too (REQ-43 BC-5).
  const badge = <IssueStatusChip status={issue.status} />;

  return (
    <ReleaseApprovalProvider value={standingQ.data?.releaseApproval}>
      <div className="min-h-full bg-app" data-testid="issue-detail" data-view={view}>
        <IssueHeader
          issue={issue}
          slug={slug}
          linkId={id}
          back={back}
          badge={badge}
          start={start}
          isRunActive={isRunActive}
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
          <DetailMobileTitle title={<span title={issue.displayId}><Written className="break-words" text={issue.title} lang={issue.writtenLang} /></span>} badge={badge} />
          <IssuePageMain
            issue={issue}
            projectId={projectId}
            slug={slug}
            id={id}
            canWrite={canWrite}
            view={view}
            onView={setView}
            standingQ={standingQ}
            blocker={blocker}
            threadQuestion={threadQuestion}
            // the answer to a park is owed the master's pickup: it is what moves the parked issue on
            onAnswerInThread={canWrite ? (text) => answerInThread.mutateAsync({ body: text, intent: "question" }) : undefined}
            agentState={agentState}
            liveStep={liveStep}
            attachmentsQ={attachmentsQ}
            commentsQ={commentsQ}
            activityQ={activityQ}
            membersQ={membersQ}
            mockupTarget={mockupTarget}
            mockupCount={mockupsQ.data?.returned}
            checklist={checklist}
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

/** The issue's status as a chip, in this project's tone for it. */
function IssueStatusChip({ status }: { status: IssueStatus }) {
  const tone = useStatusTone(status);
  return <StatusBadge family="issue" value={status} tone={tone} />;
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
        owner={standing ? standing.standing.owner : undefined}
        standing={standing?.standing}
        developer={developer}
      />
    </FactsRail>
  );
}

/** The page's header: back to the list, the title (its key the tooltip, REQ-11 BC-19), the status control and the issue's acts. */
function IssueHeader({ back, badge, ...acts }: ComponentProps<typeof IssueActions> & { back: string; badge: ReactNode }) {
  const t = useCopy();
  const { issue } = acts;
  return (
    <DetailHeader
      back={{ href: back, label: t("issues.screen.title") }}
      title={
        <span title={issue.displayId} data-testid="issue-title">
          <Written text={issue.title} lang={issue.writtenLang} />
        </span>
      }
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
