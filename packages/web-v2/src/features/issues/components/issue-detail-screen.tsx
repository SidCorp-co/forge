"use client";

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
  PipelineTracker,
  ProjectLoader,
  Skeleton,
  StatusChip,
  type TabItem,
  Tabs,
} from "@/design";
import { STAGES, type StageKey } from "@/design/stages";
import type { StatusKey } from "@/design/status";
import { useProjects } from "@/features/projects/hooks";
import { buildShareLink, useRecents } from "@/features/shell";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useToast } from "@/providers/toast-provider";
import { useRouter } from "next/navigation";
// web-v2 Issue detail (`/projects/[slug]/issues/[id]`). Simple + rich in one
// derived layout: markdown description, AC checklist, collapsible agent plan,
// full PipelineTracker, Comments/Activity/Tasks tabs, and a properties rail.
// Live via WS (`['issue',id]` / `['comments',id]` / `['activities',id]`). ISS-294.
import { useEffect, useMemo, useState } from "react";
import {
  deriveBlockerState,
  deriveStageOutcomes,
  parseChecklist,
  statusToChip,
  statusToRun,
  statusToStage,
} from "../derive";
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
  useTransitionIssue,
} from "../hooks";
import type { IssueAgentSession, IssueStatus, TaskRow } from "../types";
import { ActivityFeed } from "./activity-feed";
import { AttachmentList } from "./attachment-list";
import { BlockerBanner } from "./blocker-banner";
import { CommentThread } from "./comment-thread";
import { LiveAgentPanel } from "./live-agent-panel";
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

// Human labels for the task lifecycle — the Tasks tab badge must read "In
// progress", not the raw wire value `in_progress` (ISS-349, matching the issue
// label helpers in derive.ts).
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
  // ISS-377 — which stage's artifact card is expanded (driven by tracker clicks
  // + manual toggles). `null` = all collapsed.
  const [expandedStage, setExpandedStage] = useState<StageKey | null>(null);

  useRoom(projectRoom(projectId));

  // Viewer role is read-only: hide transition/edit/comment affordances (the
  // server 403s regardless — this is UX, not the gate).
  const projectsQ = useProjects();
  const canWrite =
    projectsQ.data?.find((p) => p.id === projectId)?.role !== "viewer";

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
  const transition = useTransitionIssue();
  const pending = patch.isPending || transition.isPending;

  const issue = issueQ.data;
  const checklist = useMemo(() => {
    if (issue?.aiAcceptanceCriteria && issue.aiAcceptanceCriteria.length > 0) {
      return issue.aiAcceptanceCriteria.map((text) => ({
        text,
        checked: false,
      }));
    }
    return parseChecklist(issue?.acceptanceCriteria);
  }, [issue?.aiAcceptanceCriteria, issue?.acceptanceCriteria]);

  // Track this issue as recently-viewed (surfaces in the ⌘K Recent group).
  useEffect(() => {
    if (!issue) return;
    pushRecent({
      kind: "issue",
      id,
      label: `${issue.displayId} · ${issue.title}`,
      href: `/projects/${slug}/issues/${id}`,
      icon: "list",
    });
  }, [issue?.displayId, issue?.title, id, slug, pushRecent]);

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

  const stage = statusToStage(issue.status);
  const onTransition = (toStatus: IssueStatus) =>
    transition.mutate({ id, toStatus });
  const onPatch = (body: Parameters<typeof patch.mutate>[0]["body"]) =>
    patch.mutate({ id, body });

  // ISS-377 — these are pure derivations (not hooks), so they sit safely after
  // the loading/error early-returns. `deriveBlockerState` is the SINGLE join of
  // status / pipelineHealth.waitingOn / blocks edges (AC#2); for needs_info the
  // newest comment is the question to answer.
  const runStatus = statusToRun(issue.status, issue.agentStatus);
  // The needs_info question is the MOST RECENT comment (the API returns the
  // comment tree oldest-first, so the triggering question is the last top-level
  // node, not index 0). ISS-377 review fix.
  const needsInfoQuestion =
    issue.status === "needs_info" ? commentsQ.data?.at(-1)?.body : undefined;
  const blocker = deriveBlockerState(issue, issue.pipelineHealth, depsQ.data, {
    ...(needsInfoQuestion ? { needsInfoQuestion } : {}),
  });
  const stageCells = deriveStageOutcomes(
    stage,
    runStatus,
    handoffsQ.data,
    durationsQ.data,
    null,
  );
  const liveSession = pickActiveSession(issue.agentSessions);
  const liveStep = issue.pipelineHealth?.activeSession?.skill ?? stage;

  const focusStage = (s: StageKey) => {
    setExpandedStage(s);
    if (typeof window !== "undefined") {
      requestAnimationFrame(() =>
        document
          .getElementById(`stage-card-${s}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  };

  // Header action set (ISS-360) — wired to EXISTING transition / nav endpoints
  // only (no fabricated APIs). The contextual primary button depends on where
  // the issue sits in its lifecycle; the rest live in the ⋯ menu.
  const isTerminal = issue.status === "released" || issue.status === "closed";
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
      count: countComments(commentsQ.data),
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
    <PageContainer width="wide" className="min-h-dvh">
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
            <StatusChip status={statusToChip(issue.status)} />
            {runChip && (
              <StatusChip
                status={runChip}
                stage={runChip === "running" ? stage : undefined}
                domain="session"
              />
            )}
            <span className="fg-caption font-mono">{stage}</span>
          </div>
          <h1 className="fg-h3 mt-1.5 truncate">{issue.title}</h1>
        </div>
        <div className="hidden flex-none items-center gap-2 sm:flex">
          <HelpButton
            summary="The full record for one issue: pipeline progress, description, acceptance criteria, the agent plan, and Comments / Activity / Tasks."
            actions={[
              "Edit properties (status, priority, assignee) in the rail",
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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Main column */}
        <div className="min-w-0 space-y-4">
          {/* Tier-1: "why is it stuck" — shown only when blocked (ISS-377 AC#1). */}
          {blocker && (
            <BlockerBanner
              blocker={blocker}
              slug={slug}
              pending={pending || !canWrite}
              onApprove={() => onTransition("approved")}
              onResume={() => onTransition("reopen")}
              onProvideInfo={() => setTab("comments")}
            />
          )}

          <Card>
            <CardContent>
              {/* Tracker is the spine: per-stage state + outcome, click to focus
                  the matching artifact card (ISS-377 AC#5). */}
              <PipelineTracker
                stage={stage}
                status={runStatus}
                variant="full"
                cells={stageCells}
                selected={expandedStage ?? undefined}
                onSelect={focusStage}
              />
            </CardContent>
          </Card>

          {/* Tier-1: live-agent detail — only when an agent is active (AC#3). */}
          {liveSession && (
            <LiveAgentPanel
              session={liveSession}
              step={liveStep}
              slug={slug}
              issueId={id}
            />
          )}

          {/* Session-group continuity (ISS-376) — resumed/fresh per step. Self-
              hides when no session carries group metadata. */}
          <SessionGroupTimeline sessions={issue.agentSessions ?? []} />

          {/* Tier-2: per-stage artifact cards (AC#4/#6). */}
          <Card>
            <CardHeader>
              <CardTitle>Pipeline stages</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {STAGES.map((s) => (
                  <StepArtifactCard
                    key={s.key}
                    stage={s.key}
                    label={s.label}
                    cell={stageCells[s.key]}
                    open={expandedStage === s.key}
                    onToggle={() =>
                      setExpandedStage((cur) => (cur === s.key ? null : s.key))
                    }
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent>
              {issue.description ? (
                // Fill the full column width (ISS-351) — wide tables, code
                // blocks, and long lines use the available space rather than a
                // narrow ~70ch clamp.
                <Markdown>{issue.description}</Markdown>
              ) : (
                <p className="fg-body-sm text-muted">No description.</p>
              )}
            </CardContent>
          </Card>

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
                  {checklist.map((item, i) => (
                    <li key={i}>
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

          <Card>
            <CardContent>
              <Tabs tabs={tabs} value={tab} onChange={setTab} />
              <div className="mt-4">
                {tab === "comments" &&
                  (commentsQ.isLoading ? (
                    <TabLoading />
                  ) : (
                    <CommentThread
                      issueId={id}
                      comments={commentsQ.data ?? []}
                      members={membersQ.data}
                      readOnly={!canWrite}
                    />
                  ))}
                {tab === "activity" &&
                  (activityQ.isLoading ? (
                    <TabLoading />
                  ) : (
                    <ActivityFeed items={activityQ.data?.items ?? []} />
                  ))}
                {tab === "tasks" &&
                  (tasksQ.isLoading ? (
                    <TabLoading />
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
                members={membersQ.data}
                cost={costQ.data}
                deps={depsQ.data}
                pending={pending || !canWrite}
                onPatch={onPatch}
                onTransition={onTransition}
              />
            </CardContent>
          </Card>
        </aside>
        <div className="lg:hidden">
          <Collapsible title="Properties" defaultOpen>
            <PropertiesRail
              issue={issue}
              slug={slug}
              members={membersQ.data}
              cost={costQ.data}
              deps={depsQ.data}
              pending={pending || !canWrite}
              onPatch={onPatch}
              onTransition={onTransition}
            />
          </Collapsible>
        </div>
      </div>
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

function countComments(
  nodes: { replies: unknown[] }[] | undefined,
): number | undefined {
  if (!nodes) return undefined;
  let n = 0;
  const walk = (list: { replies: unknown[] }[]) => {
    for (const c of list) {
      n += 1;
      walk((c.replies as { replies: unknown[] }[]) ?? []);
    }
  };
  walk(nodes);
  return n;
}
