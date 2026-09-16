"use client";

// web-v2 Issue detail (`/projects/[slug]/issues/[id]`, ISS-294). Live via WS on the keys
// `['issue',id]` / `['comments',id]` / `['activities',id]` — the event-router invalidates
// exactly those, so a query keyed anything else here stops updating and nothing reports it.

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  EmptyState,
  ErrorState,
  HelpButton,
  IconButton,
  Markdown,
  Menu,
  type MenuItem,
  MonoTag,
  PageContainer,
  ProjectLoader,
  Skeleton,
  StatusChip,
  type TabItem,
  Tabs,
} from "@/design";
import type { StatusKey } from "@/design/status";
import { useResumeRun } from "@/features/pipeline/hooks";
import { useProjects } from "@/features/projects/hooks";
import { DECISION_PANEL_ANCHOR, DecisionPanel } from "@/features/questions/components/decision-panel";
import { buildShareLink, useRecents } from "@/features/shell";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  deriveBlockerState,
  deriveStepOutcomes,
  runningStepOf,
  parseChecklist,
  statusLabelFor,
  statusToChip,
} from "../derive";
import { deriveQueuedStep } from "../waiting";
import {
  useActivity,
  useAttachments,
  useComments,
  useIssue,
  useStepDurations,
  useStepHandoffs,
  useTasks,
} from "../detail-hooks";
import {
  useIssueCost,
  useIssueDeps,
  usePatchIssue,
  useProjectMembers,
} from "../hooks";
import type { IssueAgentSession, IssueStatus, TaskRow } from "../types";
import { ActivityFeed } from "./activity-feed";
import { AttachmentList } from "./attachment-list";
import { AwaitingReleaseBanner } from "./awaiting-release-banner";
import { BlockerBanner } from "./blocker-banner";
import { useGuardedTransition } from "./use-guarded-transition";
import { CommentThread } from "./comment-thread";
import { DescriptionCard } from "./description-card";
import { type LiveAgentState, LiveAgentPanel } from "./live-agent-panel";
import { ModulePicker } from "./module-picker";
import { PropertiesRail } from "./properties-rail";
import { SessionGroupTimeline } from "./session-group-timeline";
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
  const [tab, setTab] = useState("comments");
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  useRoom(projectRoom(projectId));

  const projectsQ = useProjects();
  const projectRole = projectsQ.data?.find((p) => p.id === projectId)?.role;
  const canWrite = projectRole !== "viewer";
  const [modulePickerOpen, setModulePickerOpen] = useState(false);

  const issueQ = useIssue(id);
  const commentsQ = useComments(id);
  const activityQ = useActivity(id);
  const tasksQ = useTasks(id);
  const attachmentsQ = useAttachments(id);
  const depsQ = useIssueDeps(id);
  const costQ = useIssueCost(id);
  const membersQ = useProjectMembers(projectId);
  const handoffsQ = useStepHandoffs(projectId, id);
  const durationsQ = useStepDurations(projectId, id);

  const patch = usePatchIssue();
  const { requestTransition, dialog: reasonDialog, isPending: transitionPending } =
    useGuardedTransition();
  const qc = useQueryClient();
  const resumeRun = useResumeRun();
  const onResumeRun = (runId: string) =>
    resumeRun.mutate(runId, {
      onSuccess: () => qc.invalidateQueries({ queryKey: ["issue", id] }),
    });
  const pending = patch.isPending || transitionPending || resumeRun.isPending;

  const issue = issueQ.data;
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
          onRetry={() => issueQ.refetch()}
        />
      </div>
    );
  }

  const onTransition = (toStatus: IssueStatus) => requestTransition(id, toStatus);
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) =>
    patch.mutate({ id, body });

  const onApprove = () => requestTransition(id, "approved", { successMessage: "Issue approved" });
  const onBannerResume = () =>
    requestTransition(id, "reopen", { successMessage: "Issue resumed" });

  const blocker = deriveBlockerState(issue, issue.pipelineHealth, depsQ.data);
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
      requestAnimationFrame(() =>
        document.getElementById(DECISION_PANEL_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  };

  const isTerminal = issue.status === "awaiting_release" || issue.status === "closed";
  const isParked = issue.status === "on_hold";
  const isRunActive =
    issue.agentStatus === "running" ||
    issue.agentStatus === "queued" ||
    issue.status === "in_progress" ||
    issue.status === "reopen";
  const openSessions = () =>
    router.push(`/projects/${slug}/agents?issue=${id}`);
  const openPipeline = () => router.push(`/projects/${slug}/pipeline`);

  const moreItems: MenuItem[] = [
    { label: "Open pipeline", icon: "pipeline", onSelect: openPipeline },
    ...(isTerminal || isParked || !canWrite
      ? []
      : [
          {
            label: "Pause (hold)",
            icon: "stop",
            onSelect: () => onTransition("on_hold"),
          } as MenuItem,
        ]),
    ...(isTerminal || !canWrite
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
    { value: "tasks", label: "Tasks", count: tasksQ.data?.length },
  ];

  // Live agent-run status for the header — shown as a SESSION-domain chip
  // (squared + agent glyph) right next to the issue's lifecycle chip so the two
  // status vocabularies are never confused (ISS-360, the reporter's core ask).
  const runChip: StatusKey | null =
    issue.agentStatus === "running"
      ? "running"
      : issue.agentStatus === "queued"
        ? "queued"
        : issue.agentStatus === "completed"
          ? "done"
          : issue.agentStatus === "failed"
            ? "failed"
            : null;

  return (
    <PageContainer className="min-h-dvh">
      {/* Sticky action + state bar — keeps the id, live status, and the primary
          actions reachable while scrolling a long issue (ISS-347). The shell's
          TopBar now carries the breadcrumb trail (ISS-358/359), so the in-page
          breadcrumb was removed to stop the doubled header that hid the detail
          (ISS-360 regression). Full-bleed via negative gutters. */}
      <div className="sticky top-0 z-20 -mx-4 mb-5 flex items-start gap-3 border-b border-line-subtle bg-app/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8">
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
            {
        }
        <StatusChip status={statusToChip(issue.status)} label={statusLabelFor(issue.status)} />
            {runChip && (
              <StatusChip
                status={runChip}
                stage={runChip === "running" ? (liveStep ?? undefined) : undefined}
                domain="session"
              />
            )}
            {liveStep && <span className="fg-caption font-mono">{liveStep}</span>}
          </div>
          <h1 className="fg-h3 mt-1.5 truncate">{issue.title}</h1>
        </div>
        <div className="hidden flex-none items-center gap-2 sm:flex">
          <HelpButton
            summary="The full record for one issue: pipeline progress, description, acceptance criteria, the agent plan, and Comments / Activity / Tasks."
            actions={[
              "Edit properties (status, priority, complexity) in the rail",
              "Run / pause / reopen the pipeline from the header",
              "Jump to related sessions, pipeline, and runs",
            ]}
            shortcuts={[{ keys: "⌘K", desc: "Open the command palette" }]}
          />
          {!canWrite || isTerminal ? (
            canWrite ? (
              <Button
                variant="primary"
                size="sm"
                icon="rerun"
                loading={pending}
                onClick={() => onTransition("reopen")}
              >
                Reopen
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon="pipeline"
                onClick={openPipeline}
              >
                View pipeline
              </Button>
            )
          ) : isRunActive ? (
            <Button
              variant="secondary"
              size="sm"
              icon="stop"
              loading={pending}
              onClick={() => onTransition("on_hold")}
            >
              Pause
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon="pipeline"
              onClick={openPipeline}
            >
              Run pipeline
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            icon="agent"
            onClick={openSessions}
          >
            Open session
          </Button>
          <Menu
            align="right"
            items={moreItems}
            trigger={<IconButton icon="more" aria-label="Issue actions" />}
          />
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          {blocker && (
            <BlockerBanner
              blocker={blocker}
              slug={slug}
              pending={pending || !canWrite}
              onApprove={onApprove}
              onResume={onBannerResume}
              onResumeRun={onResumeRun}
              onProvideInfo={focusDecisions}
            />
          )}

          <DecisionPanel issueId={issue.id} parkedForInfo={issue.status === "needs_info"} />

          <AwaitingReleaseBanner
            projectId={issue.projectId}
            issueId={issue.id}
            canWrite={canWrite}
          />

          {reasonDialog}

          {agentState && (
            <LiveAgentPanel
              state={agentState}
              step={liveStep ?? "—"}
              slug={slug}
              issueId={id}
            />
          )}

          {/* Session-group continuity (ISS-376) — resumed/fresh per step. Self-
              hides when no session carries group metadata. */}
          <SessionGroupTimeline sessions={issue.agentSessions ?? []} />

          <Card>
            <CardHeader>
              <CardTitle>Steps</CardTitle>
            </CardHeader>
            <CardContent>
              {handoffsQ.isLoading || durationsQ.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 rounded-lg" />
                  <Skeleton className="h-10 rounded-lg" />
                </div>
              ) : stepOutcomes.length === 0 ? (
                <EmptyState
                  title="No steps yet"
                  message="Nothing has run on this issue. Steps appear here as agents record them."
                  mascot={false}
                />
              ) : (
                <div className="space-y-2">
                  {stepOutcomes.map((outcome) => (
                    <StepArtifactCard
                      key={outcome.step}
                      outcome={outcome}
                      open={expandedStep === outcome.step}
                      onToggle={() =>
                        setExpandedStep((cur) => (cur === outcome.step ? null : outcome.step))
                      }
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <DescriptionCard
            issue={issue}
            attachments={attachmentsQ.data ?? []}
            canWrite={canWrite}
          />

          <Card>
            <CardHeader>
              <CardTitle>Attachments</CardTitle>
            </CardHeader>
            <CardContent>
              {attachmentsQ.isLoading ? (
                <Skeleton variant="text" className="w-40" />
              ) : (attachmentsQ.data?.length ?? 0) === 0 ? (
                <p className="fg-body-sm text-muted">No attachments.</p>
              ) : (
                <AttachmentList rows={attachmentsQ.data ?? []} />
              )}
            </CardContent>
          </Card>

          {checklist.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Acceptance criteria</CardTitle>
              </CardHeader>
              <CardContent>
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
              </CardContent>
            </Card>
          )}

          {issue.plan && (
            <Collapsible title="Agent plan">
              <Markdown>{issue.plan}</Markdown>
            </Collapsible>
          )}

          <Card id="issue-comments">
            <CardContent>
              <Tabs tabs={tabs} value={tab} onChange={setTab} />
              <div className="mt-4">
                {tab === "comments" &&
                  (commentsQ.isLoading ? (
                    <TabLoading />
                  ) : commentsQ.isError ? (
                    <TabError query={commentsQ} what="comments" />
                  ) : (
                    <CommentThread
                      issueId={id}
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
                {tab === "tasks" &&
                  (tasksQ.isLoading ? (
                    <TabLoading />
                  ) : tasksQ.isError ? (
                    <TabError query={tasksQ} what="tasks" />
                  ) : (tasksQ.data?.length ?? 0) === 0 ? (
                    <EmptyState
                      title="No tasks"
                      message="This issue has no sub-tasks."
                      mascot={false}
                    />
                  ) : (
                    <ul className="space-y-2">
                      {tasksQ.data?.map((t) => (
                        <li
                          key={t.id}
                          className="flex items-center justify-between gap-3 rounded-md border border-line-subtle px-3 py-2"
                        >
                          <span className="fg-body-sm min-w-0 truncate text-fg">
                            {t.title}
                          </span>
                          <Badge tone={TASK_STATUS_TONE[t.status]}>
                            {TASK_STATUS_LABELS[t.status]}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Properties rail — desktop sidebar (sticky so it stays in view while
            reading a long comment thread, ISS-347 follow-up); mobile collapsible.
            `self-start` keeps the grid item at content height so sticky has room;
            `top-20` clears the pinned action bar; a max-height + scroll keeps a
            long rail (many deps) usable. */}
        <aside className="hidden lg:sticky lg:top-20 lg:block lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle>Properties</CardTitle>
            </CardHeader>
            <CardContent>
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
              />
            </CardContent>
          </Card>
        </aside>
        <div className="lg:hidden">
          <Collapsible title="Properties" defaultOpen>
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

/** Error body for a detail tab whose query failed, with the retry that gets the
 *  reader out of it. */
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
      onRetry={() => query.refetch()}
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
