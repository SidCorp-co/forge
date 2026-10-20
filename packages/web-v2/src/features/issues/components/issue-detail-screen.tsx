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
  Button,
  Checkbox,
  Collapsible,
  ErrorState,
  HelpButton,
  IconButton,
  Markdown,
  MonoTag,
  PageContainer,
  PageTitle,
  ProjectLoader,
  Skeleton,
  StatusChip,
  Tabs,
  type TabItem,
} from "@/design";
import { useResumeRun } from "@/features/runs/hooks";
import { useProjects } from "@/features/projects/hooks";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import { DecisionPanel, focusDecisionPanel } from "@/features/questions/components/decision-panel";
import { buildShareLink, useRecents } from "@/features/shell";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
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
import { useIssuePark } from "../park";
import type { IssueAgentSession, IssueStatus } from "../types";
import { ActivityFeed } from "./activity-feed";
import { AwaitingReleaseBanner } from "./awaiting-release-banner";
import { BlockerBanner } from "./blocker-banner";
import { IssueHeaderActions } from "./issue-header-actions";
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

  const onBannerResume = () =>
    requestTransition(issue.id, "reopen", { successMessage: "Issue resumed", onSuccess: refreshIssue });

  const blocker = deriveBlockerState(issue, issue.pipelineHealth, depsQ.data, park);
  const liveStep = liveStepWords(issue.pipelineHealth?.activeSession);
  // A group run names its members by the canonical key, never the project prefix (ISS-992).
  const runs = deriveRunView(journalQ.data, issue.agentSessions, `ISS-${issue.issSeq}`);
  const holding = (holdsQ.data?.holds?.find((h) => h.issueId === issue.id)?.holders ?? []).flatMap((h) =>
    h.by === "session" ? [h.sessionId] : [],
  );
  const sessionId = issueSessionId(holding, runs);
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

  // The run's state is a session chip beside the issue's lifecycle chip, never merged into it (ISS-360, ISS-1150),
  // read from the run journal alone: until it answers, the header says nothing about the run (ISS-1228).
  const runChip = issueRunChip(runs, { answered: journalQ.data !== undefined, failed: journalQ.isError }, now);
  const runWord = runChip.state === "read" ? runChip.word : null;
  const isRunActive =
    runChip.state === "read" ? runChip.open || issue.status === "in_progress" || issue.status === "reopen" : null;

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
      {/* Sticky action + state bar — keeps the id, live status, and the primary
          actions reachable while scrolling a long issue (ISS-347). The shell's
          TopBar now carries the breadcrumb trail (ISS-358/359), so the in-page
          breadcrumb was removed to stop the doubled header that hid the detail
          (ISS-360 regression). Full-bleed via negative gutters. Opaque with a visible line: content
          scrolling under a see-through bar read as a ghost control beside the status chip (ISS-1228). */}
      <div ref={stickyHeader} className="sticky top-0 z-20 -mx-4 mb-5 flex flex-wrap items-start gap-3 border-b border-line bg-app px-4 py-3 sm:-mx-8 sm:px-8">
        <IconButton
          icon="arrowRight"
          aria-label="Back to issues"
          className="rotate-180"
          onClick={() => router.push(`/projects/${slug}/issues`)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <MonoTag hue="cobalt">{issue.displayId}</MonoTag>
            {/* Issue lifecycle (pill) vs live agent run (squared, agent glyph). */}
            <StatusChip status={statusToChip(issue.status)} label={statusLabel(issue.status)} />
            {runChip.state === "unread" && (
              <span role="status" aria-label="Reading the run" className="inline-flex">
                <Skeleton className="h-6 w-24" />
              </span>
            )}
            {runChip.state === "unreadable" && (
              <>
                <span role="status" className="fg-caption text-muted">
                  The run could not be read.
                </span>
                <Button variant="secondary" size="sm" icon="rerun" onClick={() => journalQ.refetch()}>
                  Retry
                </Button>
              </>
            )}
            {runWord && (
              <span className="inline-flex" title={runWord.detail}>
                <StatusChip
                  status={runWord.status}
                  label={runWord.label}
                  stage={runWord.status === "running" ? (liveStep ?? undefined) : undefined}
                  domain="session"
                />
              </span>
            )}
            {liveStep && runWord && runWord.status !== "running" && (
              <span className="fg-caption">{liveStep}</span>
            )}
          </div>
          <PageTitle className="fg-h3 mt-1.5 break-words">{issue.title}</PageTitle>
        </div>
        {/* Its own row under the title at phone width rather than hidden there: the help tells a
            reader to choose Reopen at the top of the issue page, on whatever screen they read it. */}
        <div className="flex basis-full flex-wrap items-center gap-2 sm:flex-none sm:basis-auto">
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
            sessionHref={sessionId ? `/projects/${slug}/agents/${sessionId}` : null}
            status={issue.status}
            releaseRunId={issue.releaseBatchRunId}
            canWrite={canWrite}
            pending={pending}
            isRunActive={isRunActive}
            runsUnreadable={runChip.state === "unreadable"}
            onTransition={onTransition}
            onRun={() => runIssue.mutate(issue.id, { onSuccess: refreshIssue })}
            running={runIssue.isPending}
            onCopyLink={copyLink}
          />
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_clamp(16rem,32%,22.5rem)] 2xl:grid-cols-[minmax(0,1fr)_clamp(16rem,32%,23.75rem)]">
        <div className="min-w-0 space-y-4">
          {blocker && (
            <BlockerBanner
              blocker={blocker}
              slug={slug}
              pending={pending || !canWrite}
              onResume={onBannerResume}
              onResumePark={onTransition}
              onResumeRun={onResumeRun}
              onProvideInfo={focusDecisions}
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
            canWrite={canWrite}
            mergeMark={issue.mergeMark}
          />

          {reasonDialog}

          <LeaseDisagreementNotice projectId={projectId} issueId={issue.id} slug={slug} />

          {agentState && (
            <LiveAgentPanel
              state={agentState}
              step={liveStep ?? "—"}
              slug={slug}
            />
          )}

          <ReleaseNoteSection issue={issue} />

          <DescriptionSection
            issue={issue}
            attachments={attachmentsQ.data ?? []}
            attachmentsLoading={attachmentsQ.isLoading}
            attachmentsError={attachmentsQ.isError ? attachmentsQ.error : null}
            canWrite={canWrite}
          />

          <RunJournalSection
            runs={runs}
            loading={journalQ.isLoading}
            error={journalQ.isError ? journalQ.error : null}
            onRetry={() => journalQ.refetch()}
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
              {tab === "comments" &&
                (commentsQ.isLoading ? (
                  <TabLoading />
                ) : commentsQ.isError ? (
                  <TabError query={commentsQ} what="comments" />
                ) : (
                  <CommentThread
                    issueId={issue.id}
                    comments={commentsQ.data?.items ?? []}
                    members={membersQ.data}
                    readOnly={!canWrite}
                  />
                ))}
              {tab === "activity" &&
                (activityQ.isLoading ? (
                  <TabLoading />
                ) : activityQ.isError ? (
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
            pending={pending || !canWrite}
            onPatch={onPatch}
            onTransition={onTransition}
            onEditModules={canWrite ? () => setModulePickerOpen(true) : undefined}
            canMarkMerged={canWrite}
            park={statusPark}
            runWord={runWord}
          />
        </aside>
        <div className="border-t border-line-subtle lg:hidden">
          <Collapsible title="Properties" defaultOpen flat>
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
              runWord={runWord}
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
