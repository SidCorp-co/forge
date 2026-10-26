"use client";

// web-v2 Issue detail (`/projects/[slug]/issues/[id]`, ISS-294). Live via WS on the keys
// `['issue',id]` / `['comments',id]` / `['activities',id]` — the event-router invalidates
// exactly those, so a query keyed anything else here stops updating and nothing reports it.
//
// The sections this file draws are flat, with no Card: after the banners, the main column reads the
// release note, Description, Runs, Acceptance criteria, Agent plan, then the Comments / Activity region,
// each ruled off from the one above by a hairline. The Properties rail sits beside it behind a
// hairline at `lg` and under it as a disclosure below.

import { useNow } from "@/design/hooks/use-now";
import {
  Checkbox,
  Collapsible,
  ErrorState,
  HelpButton,
  Markdown,
  MonoTag,
  PageContainer,
  ProjectLoader,
  Skeleton,
  StaleReadLine,
  StatusChip,
  Tabs,
  type TabItem,
} from "@/design";
import { useResumeRun } from "@/features/runs/hooks";
import { useProjects } from "@/features/projects/hooks";
import { ProjectMissing } from "@/features/projects/components/project-missing";
import { useIssueQuestions } from "@/features/questions/hooks";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import { DecisionPanel, focusDecisionPanel } from "@/features/questions/components/decision-panel";
import { buildShareLink, useRecents } from "@/features/shell";
import type { IssueReadRefusalDetails } from "@forge/contracts";
import { ApiError } from "@/lib/api/client";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { clockAt, couldNotRefresh, heldThroughFailure, offersRetry, projectGone } from "@/lib/api/read-failed";
import { useAskAgainWhenAccessReturns } from "@/lib/api/ask-again-when-access-returns";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  canonicalIssueId,
  deriveBlockerState,
  deriveRunView,
  issueRunChip,
  issueQueryKey,
  issueSessionId,
  liveStepWords,
  parseChecklist,
  threadQuestionOf,
  statusLabel,
  statusToChip,
} from "../derive";
import { deriveQueuedStep } from "../waiting";
import {
  useActivity,
  useAttachments,
  useComments,
  useCreateComment,
  useIssue,
  useRunJournal,
} from "../detail-hooks";
import {
  useIssueCost,
  useIssueDeps,
  usePatchIssue,
  useProjectMembers,
  useRunPipelineStep,
} from "../hooks";
import { agentHoldsIssue, heldByAgent } from "../edit-lock";
import { useIssuePark } from "../park";
import type { IssueAgentSession, IssueStatus } from "../types";
import { ActivityFeed } from "./activity-feed";
import { mayRelease } from "../release-who";
import { AwaitingReleaseBanner } from "./awaiting-release-banner";
import { BlockerBanner } from "./blocker-banner";
import { IssueHeaderActions } from "./issue-header-actions";
import { HeaderReadFailures, IssueStickyHeader } from "./issue-sticky-header";
import { useGuardedTransition } from "./use-guarded-transition";
import { CommentThread } from "./comment-thread";
import { DescriptionSection } from "./description-section";
import { FlatSection } from "./flat-section";
import { ReleaseNoteSection } from "./release-note-section";
import { LeaseDisagreementNotice } from "./lease-disagreement-notice";
import { type LiveAgentState, LiveAgentPanel } from "./live-agent-panel";
import { ModulePicker } from "./module-picker";
import { PropertiesRail } from "./properties-rail";
import { RunJournalSection } from "./run-journal-section";
import { RunWordChip } from "./run-word-chip";

interface IssueDetailScreenProps {
  projectId: string;
  slug: string;
  id: string;
}

/**
 * The issue read refused because the issue belongs to a project closed to this reader, read off the
 * refusal's `details` — which name each project only where the reader may see it (ISS-1229 r41).
 */
function closedIssueRead(err: unknown): IssueReadRefusalDetails | null {
  if (!(err instanceof ApiError) || err.status !== 403) return null;
  const d = err.details as Partial<IssueReadRefusalDetails> | undefined;
  return d?.issueProject && typeof d.issueProject === "object" && d.addressProject ? (d as IssueReadRefusalDetails) : null;
}

export function IssueDetailScreen({
  projectId,
  slug,
  id,
}: IssueDetailScreenProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { push: pushRecent } = useRecents();
  const [tab, setTab] = useState("comments");

  useRoom(projectRoom(projectId));

  const projectsQ = useProjects();
  const projectRole = projectsQ.data?.find((p) => p.id === projectId)?.role;
  const canWrite = projectRole !== "viewer";
  const [modulePickerOpen, setModulePickerOpen] = useState(false);

  // ISS-1160 — `id` off the URL is the display key as often as the row uuid;
  // `projectId` (already resolved from the route's slug) is what lets it
  // resolve on every one of these reads.
  const issueQ = useIssue(id, projectId);
  const canonicalId = canonicalIssueId(id, issueQ.data?.id);
  const commentsQ = useComments(canonicalId, projectId);
  const activityQ = useActivity(canonicalId, projectId);
  const attachmentsQ = useAttachments(canonicalId, projectId);
  const depsQ = useIssueDeps(canonicalId, true, projectId);
  const costQ = useIssueCost(canonicalId, true, projectId);
  const membersQ = useProjectMembers(projectId);
  const journalQ = useRunJournal(projectId, canonicalId);
  const holdsQ = useSessionsAndHolds(projectId);
  // The decisions read the panel shows, read here too so the banner never points at a question it could not load.
  const questionsQ = useIssueQuestions(issueQ.data?.id ?? "");
  useAskAgainWhenAccessReturns([issueQ, journalQ, holdsQ, commentsQ, activityQ, attachmentsQ, depsQ, costQ, questionsQ, membersQ]);
  const now = useNow(10_000);

  const patch = usePatchIssue();
  const {
    requestTransition,
    requestParkLeave,
    dialog: reasonDialog,
    isPending: transitionPending,
  } = useGuardedTransition();
  const qc = useQueryClient();
  const resumeRun = useResumeRun();
  const runIssue = useRunPipelineStep();
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
  const issueDisplayId = issue?.displayId;
  const issueTitle = issue?.title;
  // A uuid reads whichever project holds the issue, so an address naming another project is followed to
  // the issue's own, never drawn under the address's breadcrumb (ISS-1229 r40, judge-111).
  const elsewhere = issue !== undefined && issue.projectId !== projectId;
  const ownSlug = elsewhere ? projectsQ.data?.find((p) => p.id === issue.projectId)?.slug : undefined;

  useEffect(() => {
    if (ownSlug) router.replace(`/projects/${ownSlug}/issues/${id}`);
  }, [ownSlug, id, router]);

  useEffect(() => {
    if (!issueDisplayId || !issueTitle || elsewhere) return;
    pushRecent({
      kind: "issue",
      id,
      label: `${issueDisplayId} · ${issueTitle}`,
      href: `/projects/${slug}/issues/${id}`,
      icon: "list",
    });
  }, [issueDisplayId, issueTitle, id, slug, pushRecent, elsewhere]);

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
  // The project's own read answering 404 is the project gone: the page says so once, with nothing to act on (ISS-1228 r26).
  if (holdsQ.isError && projectGone(holdsQ.error)) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectMissing slug={slug} />
      </div>
    );
  }
  // An issue read that answered and then failed keeps the page as it was read; only one that never answered blanks it.
  const closed = issue ? null : closedIssueRead(issueQ.error);
  if (closed) {
    const here = projectsQ.data?.find((p) => p.id === projectId)?.name ?? slug;
    const name = closed.issueProject.name;
    const owner = name ? `${name}, a project` : "a project";
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {/* The whole page: its title is the page's heading and the tab's title (ISS-1229 r43, judge-120). */}
        <ErrorState
          level={1}
          title={`This issue is not in ${here}`}
          message={`It belongs to ${owner} you are not a member of. An admin of ${name ?? "that project"}, or an owner or admin of its organization, can add you.`}
          action={{ label: `Back to ${here}'s issues`, href: `/projects/${slug}/issues` }}
        />
      </div>
    );
  }
  if (!issue) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          level={1}
          title="Couldn't load issue"
          message={formatApiError(issueQ.error)}
          onRetry={isRetryableApiError(issueQ.error) ? () => issueQ.refetch() : undefined}
        />
      </div>
    );
  }

  if (elsewhere) {
    const here = projectsQ.data?.find((p) => p.id === projectId)?.name ?? slug;
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {ownSlug || projectsQ.isLoading ? (
          <ProjectLoader label="opening it in its own project…" />
        ) : (
          <ErrorState
            level={1}
            title={`${issue.displayId} is not in ${here}`}
            message="It belongs to another project, which this address does not name."
          />
        )}
      </div>
    );
  }

  const issueStale = heldThroughFailure(issueQ);
  // Every write rests on the issue as read: while its refresh fails, none is offered (ISS-1228 r26).
  const mayWrite = canWrite && !issueStale;

  const onTransition = (toStatus: IssueStatus) =>
    requestTransition(issue.id, toStatus, { onSuccess: refreshIssue });
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) =>
    patch.mutate({ id: issue.id, body }, { onSuccess: refreshIssue });

  const onBannerResume = () =>
    requestTransition(issue.id, "reopen", { successMessage: "Issue resumed", onSuccess: refreshIssue });

  const blocker = deriveBlockerState(
    issue,
    issue.pipelineHealth,
    depsQ.data,
    park,
    questionsQ.isError && questionsQ.data === undefined,
  );
  const liveStep = liveStepWords(issue.pipelineHealth?.activeSession);
  // A group run names its members by the canonical key, never the project prefix (ISS-992).
  const runs = deriveRunView(journalQ.data, issue.agentSessions, `ISS-${issue.issSeq}`);
  // Until the holds read answers, which session holds the issue is unknown, so none opens (ISS-1228).
  const holding = holdsQ.isError
    ? ("unread" as const)
    : holdsQ.data === undefined
      ? ("reading" as const)
      : (holdsQ.data.holds?.find((h) => h.issueId === issue.id)?.holders ?? []).flatMap((h) =>
          h.by === "session" ? [h.sessionId] : [],
        );
  const sessionId = issueSessionId(holding, runs);
  const liveSession = pickActiveSession(issue.agentSessions);
  const queuedStep = deriveQueuedStep(issue.pipelineHealth, !!liveSession);
  const agentState: LiveAgentState | null = liveSession
    ? { kind: "live", session: liveSession }
    : queuedStep
      ? { kind: "queued", step: queuedStep, saidAbove: !!queuedStep.gate && blocker?.reason === queuedStep.gate.detail }
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
  const statusPark = mayWrite ? { reading: park, actions: parkActions } : undefined;
  const threadQuestion = park.state === "ready" && park.park ? threadQuestionOf(park.park) : null;

  // The run's state is a session chip beside the issue's lifecycle chip, never merged into it (ISS-360, ISS-1150),
  // read from the run journal alone: until it answers, the header says nothing about the run (ISS-1228). A journal
  // that answered and then failed keeps its word as of when it was read, and no act rests on it (ISS-1228 r26).
  const runChip = issueRunChip(
    runs,
    { answered: journalQ.data !== undefined, failed: journalQ.isError, readAt: journalQ.dataUpdatedAt },
    now,
  );
  const runWord = runChip.state === "read" || runChip.state === "stale" ? runChip.word : null;
  const runAsOf = runChip.state === "stale" ? clockAt(runChip.readAt) : null;
  const isRunActive =
    runChip.state === "read" ? runChip.open || issue.status === "in_progress" || issue.status === "reopen" : null;

  // A read that failed says so, with why and Retry, never drawn as no relations or no cost (ISS-1228); one that
  // answered first says when what it still lists was read (r26).
  const unreadOf = (q: { isError: boolean; error: unknown; data: unknown; dataUpdatedAt: number; refetch: () => unknown }) =>
    q.isError
      ? {
          error: q.error,
          retry: offersRetry(q.error) ? () => void q.refetch() : undefined,
          readAt: heldThroughFailure(q) ? q.dataUpdatedAt : undefined,
        }
      : undefined;
  const railUnread = { deps: unreadOf(depsQ), cost: unreadOf(costQ) };
  // Every read the header rests on says a failure on its one row, never in the chips or the toolbar (ISS-1228 r25),
  // whether or not it answered before it failed (r26).
  const failedRead = (what: string, q: { error: unknown; refetch: () => unknown }) => ({
    what,
    error: q.error,
    retry: offersRetry(q.error) ? () => void q.refetch() : undefined,
  });
  const headerUnread = [
    ...(issueQ.isError ? [failedRead("The issue", issueQ)] : []),
    ...(journalQ.isError ? [failedRead("The run", journalQ)] : []),
    ...(holdsQ.isError ? [failedRead("Its session", holdsQ)] : []),
  ];
  const agentHolds = canWrite && heldByAgent(issue.status, issue.agentStatus);
  // The lock line speaks from the same reading as the run chip: kept through a failure, it says as of when (ISS-1228 r27).
  const keptReadings = [issueStale ? issueQ.dataUpdatedAt : null, runChip.state === "stale" ? runChip.readAt : null].filter(
    (at): at is number => at !== null,
  );
  const keptSince = keptReadings.length > 0 ? Math.min(...keptReadings) : null;
  const heldAt = (q: { isError: boolean; data: unknown; dataUpdatedAt: number }) =>
    heldThroughFailure(q) ? q.dataUpdatedAt : undefined;

  const tabs: TabItem[] = [
    {
      value: "comments",
      label: "Comments",
      count: commentsQ.data?.totalCount,
    },
    {
      value: "activity",
      label: "Activity",
      count: activityQ.data?.items.length,
    },
  ];

  return (
    <PageContainer className="min-h-dvh">
      {/* Sticky action + state bar — keeps the id, live status, and the primary actions reachable
          while scrolling a long issue (ISS-347). Full-bleed via negative gutters. */}
      <IssueStickyHeader
        ref={stickyHeader}
        onBack={() => router.push(`/projects/${slug}/issues`)}
        chips={
          <>
            <MonoTag hue="cobalt">{issue.displayId}</MonoTag>
            {/* Issue lifecycle (pill) vs live agent run (squared, agent glyph). */}
            <StatusChip status={statusToChip(issue.status)} label={statusLabel(issue.status)} />
            {issueStale && <span className="fg-caption fg-caption-stale">as of {clockAt(issueQ.dataUpdatedAt)}</span>}
            {runChip.state === "unread" && (
              <span role="status" aria-label="Reading the run" className="inline-flex">
                <Skeleton className="h-6 w-24" />
              </span>
            )}
            {runWord && (
              <RunWordChip
                word={runWord}
                asOf={runAsOf}
                stage={runChip.state === "read" && runWord.status === "running" ? (liveStep ?? undefined) : undefined}
              />
            )}
            {liveStep && runChip.state === "read" && runWord && runWord.status !== "running" && (
              <span className="fg-caption">{liveStep}</span>
            )}
          </>
        }
        title={issue.title}
        actions={
          <>
            <HelpButton
              compact
              summary="The full record for one issue: pipeline progress, description, acceptance criteria, the agent plan, and Comments / Activity."
              actions={[
                "Edit properties (status, priority, complexity) in the rail",
                "Run / pause / reopen the pipeline from the header",
                "Jump to related sessions, pipeline, and runs",
              ]}
              shortcuts={[{ keys: "⌘K", desc: "Open the command palette" }]}
            />
            <IssueHeaderActions
              slug={slug}
              sessionHref={sessionId && sessionId !== "unread" ? `/projects/${slug}/agents/${sessionId}` : null}
              status={issue.status}
              releaseRunId={issue.releaseBatchRunId}
              canWrite={mayWrite}
              pending={pending}
              isRunActive={isRunActive}
              runWaitsOn={runChip.state === "read" ? runChip.waitsOn : null}
              onAnswer={focusDecisions}
              runsUnreadable={runChip.state === "unreadable" || runChip.state === "stale"}
              onTransition={onTransition}
              onRun={() => runIssue.mutate(issue.id, { onSuccess: refreshIssue })}
              running={runIssue.isPending}
              onCopyLink={copyLink}
            />
          </>
        }
        failure={headerUnread.length > 0 ? <HeaderReadFailures reads={headerUnread} /> : null}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_clamp(16rem,32%,22.5rem)] 2xl:grid-cols-[minmax(0,1fr)_clamp(16rem,32%,23.75rem)]">
        {/* The header's own border rules off whatever comes first: a hairline there would divide nothing (ISS-1228 r26). */}
        <div className="min-w-0 space-y-4 [&>section:first-child]:border-t-0 [&>section:first-child]:pt-0">
          {blocker && (
            <BlockerBanner
              blocker={blocker}
              slug={slug}
              pending={pending || !mayWrite}
              onResume={onBannerResume}
              onResumePark={onTransition}
              onResumeRun={onResumeRun}
              onProvideInfo={focusDecisions}
              onRetryPark={park.state === "error" && offersRetry(park.error) ? park.retry : undefined}
            />
          )}

          <DecisionPanel
            issueId={issue.id}
            parkedForInfo={issue.status === "needs_info"}
            threadQuestion={threadQuestion}
            onAnswerInThread={
              canWrite ? (text) => answerInThread.mutateAsync({ body: text }) : undefined
            }
          />

          <AwaitingReleaseBanner
            projectId={issue.projectId}
            issueId={issue.id}
            canRelease={mayRelease(projectRole) && !issueStale}
            askWhoReleases={!mayRelease(projectRole) && !issueStale}
            mergeMark={issue.mergeMark}
            mergedCommitSha={issue.mergedCommitSha}
            mergedClaimedCommit={issue.mergedClaimedCommit}
          />

          {reasonDialog}

          <LeaseDisagreementNotice projectId={projectId} issueId={issue.id} slug={slug} />

          {/* Over a failed run or session read the card would claim a liveness nobody read (ISS-1228 r25). */}
          {agentState && headerUnread.length === 0 && (
            <LiveAgentPanel
              state={agentState}
              step={liveStep ?? "—"}
              slug={slug}
            />
          )}

          <ReleaseNoteSection issue={issue} />

          {/* Said once for Description and the rail, which each hold their edits without repeating it (ISS-1228 r26). */}
          {agentHolds && (
            <p role="status" className="fg-body-sm text-subtle">
              {agentHoldsIssue(clockAt(keptSince))}
            </p>
          )}

          <DescriptionSection
            issue={issue}
            attachments={attachmentsQ.data ?? []}
            attachmentsLoading={attachmentsQ.isLoading}
            attachmentsError={attachmentsQ.isError ? attachmentsQ.error : null}
            onRetryAttachments={() => attachmentsQ.refetch()}
            attachmentsReadAt={heldAt(attachmentsQ)}
            canWrite={mayWrite}
          />

          <RunJournalSection
            runs={runs}
            loading={journalQ.isLoading}
            error={journalQ.isError ? journalQ.error : null}
            onRetry={() => journalQ.refetch()}
            readAt={heldAt(journalQ)}
          />

          {checklist.length > 0 && (
            <FlatSection title="Acceptance criteria">
              <ul className="space-y-2">
                {checklist.map((item) => (
                  <li key={item.key}>
                    <Checkbox
                      checked={item.checked}
                      disabled
                      label={item.text}
                    />
                  </li>
                ))}
              </ul>
            </FlatSection>
          )}

          {issue.plan && (
            <div className="border-t border-line-subtle">
              <Collapsible title="Agent plan" flat>
                <Markdown>{issue.plan}</Markdown>
              </Collapsible>
            </div>
          )}

          <section
            id="issue-comments"
            aria-label="Comments and activity"
            className="border-t border-line-subtle pt-4"
          >
            <Tabs tabs={tabs} value={tab} onChange={setTab} />
            <div className="mt-4">
              {tab === "comments" && <StaleTabLine query={commentsQ} />}
              {tab === "comments" &&
                (commentsQ.isLoading ? (
                  <TabLoading />
                ) : commentsQ.isError && !heldThroughFailure(commentsQ) ? (
                  <TabError query={commentsQ} what="comments" />
                ) : (
                  <CommentThread
                    issueId={issue.id}
                    comments={commentsQ.data?.items ?? []}
                    members={membersQ.data}
                    readOnly={!canWrite}
                  />
                ))}
              {tab === "activity" && <StaleTabLine query={activityQ} />}
              {tab === "activity" &&
                (activityQ.isLoading ? (
                  <TabLoading />
                ) : activityQ.isError && !heldThroughFailure(activityQ) ? (
                  <TabError query={activityQ} what="activity" />
                ) : (
                  <ActivityFeed items={activityQ.data?.items ?? []} />
                ))}
            </div>
          </section>
        </div>

        {/* Properties rail — desktop sidebar (sticky so it stays in view while
            reading a long comment thread, ISS-347 follow-up); mobile collapsible.
            `self-start` keeps the grid item at content height so sticky has room;
            `top-20` clears the pinned action bar; a max-height + scroll keeps a
            long rail (many deps) usable. */}
        <aside
          aria-label="Properties"
          className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto lg:border-l lg:border-line-subtle lg:pl-6"
        >
          <h2 className="fg-label mb-2">Properties</h2>
          <PropertiesRail
            issue={issue}
            slug={slug}
            cost={costQ.data}
            deps={depsQ.data}
            pending={pending || !mayWrite}
            readOnly={!mayWrite}
            onPatch={onPatch}
            onTransition={onTransition}
            onEditModules={mayWrite ? () => setModulePickerOpen(true) : undefined}
            canMarkMerged={mayWrite}
            park={statusPark}
            runWord={runWord}
            runAsOf={runAsOf}
            unread={railUnread}
          />
        </aside>
        <div className="border-t border-line-subtle lg:hidden">
          <Collapsible title="Properties" defaultOpen flat>
            <PropertiesRail
              issue={issue}
              slug={slug}
              cost={costQ.data}
              deps={depsQ.data}
              pending={pending || !mayWrite}
              readOnly={!mayWrite}
              onPatch={onPatch}
              onTransition={onTransition}
              onEditModules={mayWrite ? () => setModulePickerOpen(true) : undefined}
              canMarkMerged={mayWrite}
              park={statusPark}
              runWord={runWord}
              runAsOf={runAsOf}
              unread={railUnread}
            />
          </Collapsible>
        </div>
      </div>

      <ModulePicker
        open={modulePickerOpen}
        onClose={() => setModulePickerOpen(false)}
        issueId={issue.id}
        projectId={projectId}
        slug={slug}
        labels={issue.labels ?? []}
      />
    </PageContainer>
  );
}

/** Skeleton placeholder for the detail tab bodies (comments / activity)
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

/** A tab whose refresh failed after it answered: what it still shows, as of when, with Retry (ISS-1228 r26). */
function StaleTabLine({
  query,
}: {
  query: { isError: boolean; data: unknown; dataUpdatedAt: number; error: unknown; refetch: () => unknown };
}) {
  if (!heldThroughFailure(query)) return null;
  return (
    <StaleReadLine
      className="mb-3"
      said={couldNotRefresh(query.dataUpdatedAt, query.error)}
      onRetry={offersRetry(query.error) ? () => void query.refetch() : undefined}
    />
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
