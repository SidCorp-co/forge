"use client";

import { useParams, useRouter } from "next/navigation";
import {
  Badge,
  EmptyState,
  ErrorState,
  IconButton,
  MonoTag,
  PageContainer,
  PageTitle,
  ProjectLoader,
  ProjectMark,
  useNow,
} from "@/design";
import { AttentionQueue } from "@/features/project-dashboard/components/attention-queue";
import { AwaitingReleaseCard } from "@/features/project-dashboard/components/awaiting-release-card";
import { ComingSoonNote } from "@/features/project-dashboard/components/dashboard-section";
import { Headline } from "@/features/project-dashboard/components/headline";
import { LiveSessionsCard } from "@/features/project-dashboard/components/live-sessions-card";
import { RunnersCard } from "@/features/project-dashboard/components/runners-card";
import { SchedulesCard } from "@/features/project-dashboard/components/schedules-card";
import { SpendCard } from "@/features/project-dashboard/components/spend-card";
import { StatStrip } from "@/features/project-dashboard/components/stat-strip";
import { StatusDonut } from "@/features/project-dashboard/components/status-donut";
import { StepTimes } from "@/features/project-dashboard/components/step-times";
import { Throughput, THROUGHPUT_WINDOW_DAYS } from "@/features/project-dashboard/components/throughput";
import {
  attentionCaption,
  attentionReadFailure,
  attentionRefusal,
  attentionCut,
  sessionsWaitingOnYou,
  idleRuns,
  joblessRuns,
  liveRuns,
  activeSpend,
  awaitingReleaseRuns,
  projectAttention,
  runnersSummary,
  spendByStep,
  statusDonut,
} from "@/features/project-dashboard/derive";
import {
  type ReadState,
  parkedAges,
  projectShape,
  secondsSince,
  spendComparison,
  stuckRuns,
} from "@/features/project-dashboard/shape";
import { useAttention } from "@/features/attention/hooks";
import { useIssues } from "@/features/issues/hooks";
import { formatElapsed } from "@/features/overview/derive";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import { useProjectRuns, useStepDurations, useThroughput } from "@/features/runs/hooks";
import { useProjectHealth, useProjects } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { useActiveRunners, useProjectRunners } from "@/features/runners/hooks";
import { useSchedules } from "@/features/schedules/hooks";
import { useQueueStats } from "@/features/sessions/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";

/** Where one query stands, in the page's own words: a read that failed (even over an earlier answer) or has not arrived is never an empty one. */
function readOf(q: { isError: boolean; error: unknown; data: unknown }): ReadState {
  if (q.isError) return { read: "failed", reason: formatApiError(q.error) };
  return q.data === undefined ? { read: "pending" } : { read: "ok" };
}

/** One state for several queries a figure depends on: failed if any failed, else pending if any is. */
function readOfAll(...qs: Array<{ isError: boolean; error: unknown; data: unknown }>): ReadState {
  const states = qs.map(readOf);
  return states.find((r) => r.read === "failed") ?? states.find((r) => r.read === "pending") ?? { read: "ok" };
}

/** The window the spend and where-time-goes sections read; the throughput section's is its own. */
const METRICS_WINDOW_DAYS = 7;

export default function ProjectOverviewPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug;

  const projectsQ = useProjects();
  const healthQ = useProjectHealth();
  const project = projectsQ.data?.find((p) => p.slug === slug);
  const projectId = project?.id;

  // All cards key onto WS-invalidated prefixes already; the page just needs to
  // subscribe to THIS project's room so cross-project events arrive (ISS-379).
  useRoom(projectId ? projectRoom(projectId) : null);

  // Card data — every hook reuses an existing source. Project-scoped hooks gate
  // on `projectId` so they no-op until the slug resolves.
  const attentionQ = useAttention();
  const runsQ = useProjectRuns(projectId);
  const sessionsQ = useSessionsAndHolds(projectId);
  const durationsQ = useStepDurations({ days: METRICS_WINDOW_DAYS, projectId }, !!projectId);
  const throughputQ = useThroughput({ days: THROUGHPUT_WINDOW_DAYS, projectId }, !!projectId);
  const queueQ = useQueueStats(projectId);
  const projectRunnersQ = useProjectRunners(projectId ?? null);
  const activeRunnersQ = useActiveRunners(projectId ?? null);
  const schedulesQ = useSchedules(projectId);

  // The health row lists at most five parked issues, with no time on them. Their ages come from the
  // issues search (newest write first, so the listed five are in it), and only where there are any.
  const parkedWanted = (healthQ.data?.find((h) => h.projectSlug === slug)?.blockers.length ?? 0) > 0;
  const parkedQ = useIssues(parkedWanted ? projectId : undefined, {
    filter: "blocked_on_person",
    sort: "updatedAt:desc",
    pageSize: 50,
  });

  // Tick once a second while some runner is limited (live reset countdown);
  // the active-runner card's busy state refreshes via its own 10s poll + WS,
  // so it does not need the per-second tick.
  const anyLimited = (projectRunnersQ.data ?? []).some((r) => r.limitReason);
  const tick = useNow(1000, anyLimited);

  const isLoading = projectsQ.isLoading || healthQ.isLoading;
  const isError = projectsQ.isError || healthQ.isError;

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading project…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          title="Couldn't load project"
          message={formatApiError(projectsQ.error ?? healthQ.error)}
          onRetry={() => {
            projectsQ.refetch();
            healthQ.refetch();
          }}
        />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <EmptyState
          title="Project not found"
          message="This project doesn't exist or you don't have access to it."
          mascot
        />
      </div>
    );
  }

  const health = healthQ.data?.find((h) => h.projectSlug === slug);
  const glyph = projectGlyph(project.id);
  const now = Date.now();

  // Nothing below states a count, a list or "All caught up" the reads have not given: until one is in,
  // the headline, the Needs you figure and the list say they are reading, and where it failed they
  // refuse by name. The health row's parked list alone is a part of the answer, not the whole of it.
  const attentionPending = attentionQ.read === "pending";
  const readFailure =
    attentionQ.read === "failed" ? attentionReadFailure(formatApiError(attentionQ.error)) : null;
  const attentionRead = attentionQ.read === "read";
  const parkedState: ReadState = !parkedWanted
    ? { read: "ok" }
    : parkedQ.isError
      ? { read: "failed", reason: formatApiError(parkedQ.error) }
      : parkedQ.data === undefined || parkedQ.isPlaceholderData
        ? { read: "pending" }
        : { read: "ok" };
  const ages = parkedState.read === "ok" ? parkedAges(parkedQ.data?.items) : undefined;
  const attention = attentionRead
    ? [
        ...projectAttention(attentionQ.view, project.slug, health?.blockers, ages),
        ...sessionsWaitingOnYou(sessionsQ.data?.sessions, project.slug),
      ]
    : [];
  // A response that cannot say how much the list leaves out is refused where the figure and the list
  // are, so the rest of the dashboard stands rather than the whole page failing.
  const attentionRefused = readFailure ?? (attentionRead ? attentionRefusal(attentionQ.view, project.slug) : null);
  const attentionLeftOut =
    attentionRead && !attentionRefused
      ? attentionCut(attention, attentionQ.view, project.slug, health?.blockersTotal, health?.work.blocked_on_person)
      : null;
  const attentionState: ReadState = attentionPending
    ? { read: "pending" }
    : attentionRefused
      ? { read: "failed", reason: readFailure ? formatApiError(attentionQ.error) : attentionRefused }
      : { read: "ok" };
  const runItems = runsQ.data?.items;
  const runsState = readOf(runsQ);
  const sessionsState = readOf(sessionsQ);
  const liveSessions = sessionsQ.data?.sessions ?? [];
  const durationsState = readOf(durationsQ);
  const throughputState = readOf(throughputQ);
  const runnersState = readOf(projectRunnersQ);
  // A runner hosting a live session is busy, so the sessions read is part of what says busy or idle.
  const activityState = readOfAll(queueQ, activeRunnersQ, sessionsQ);
  const schedulesState = readOf(schedulesQ);
  const runsIdle = idleRuns(runItems);
  const runsAwaitingRelease = awaitingReleaseRuns(runItems);
  const inFlight = activeSpend(runItems);
  const runners = runnersSummary(
    projectRunnersQ.data,
    activityState.read === "ok" ? queueQ.data : undefined,
    anyLimited ? tick : now,
    activityState.read === "ok" ? activeRunnersQ.data?.runners : undefined,
    activityState.read === "ok" ? liveSessions : undefined,
  );
  const donut = statusDonut(health?.work);
  const awaitingReleaseIssues = health?.work.awaiting_release ?? 0;
  const spend = spendByStep(durationsQ.data);
  const schedules = schedulesQ.data ?? [];

  const reading = projectShape({
    attention: attentionState,
    runs: runsState,
    sessions: sessionsState,
    parked: parkedState,
    items: attention,
    cut: attentionLeftOut,
    slug: project.slug,
    liveSessions: liveSessions.length,
    stuckRuns: stuckRuns(joblessRuns(runItems), now),
    failedJobs: attentionState.read === "ok" ? (attentionQ.view?.projectTotals[project.slug]?.failedJobs ?? 0) : 0,
    releaseRuns: runsAwaitingRelease.length,
    releaseIssues: awaitingReleaseIssues,
    now,
  });

  const oldestSeconds = attention.reduce<number | null>((oldest, it) => {
    const s = secondsSince(it.since, now);
    return s === null ? oldest : Math.max(oldest ?? 0, s);
  }, null);

  const liveSection = (
    <LiveSessionsCard
      sessions={liveSessions}
      slug={project.slug}
      now={now}
      idle={runsIdle}
      read={sessionsState}
      runsRead={runsState}
    />
  );
  const releaseSection = (
    <AwaitingReleaseCard
      runs={runsAwaitingRelease}
      slug={project.slug}
      projectId={project.id}
      awaitingReleaseIssues={awaitingReleaseIssues}
      read={runsState}
    />
  );
  const metricSections = (
    <>
      <StatusDonut data={donut} />
      <SpendCard data={spend} inFlightUsd={inFlight} read={durationsState} />
      <Throughput
        rows={throughputQ.data}
        isLoading={throughputState.read === "pending"}
        error={throughputQ.error}
        onRetry={() => throughputQ.refetch()}
      />
      <StepTimes
        durations={durationsQ.data}
        windowDays={METRICS_WINDOW_DAYS}
        isLoading={durationsState.read === "pending"}
        error={durationsQ.error}
        onRetry={() => durationsQ.refetch()}
      />
      <RunnersCard summary={runners} slug={project.slug} read={runnersState} activity={activityState} />
      <SchedulesCard rows={schedules} now={now} slug={project.slug} read={schedulesState} />
    </>
  );

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-5 flex items-center gap-4">
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(project.name)} size={40} />
        <div className="min-w-0 flex-1">
          <PageTitle className="fg-h2">{project.name}</PageTitle>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <MonoTag>{project.slug}</MonoTag>
            <Badge tone={project.role === "admin" ? "accent" : "neutral"}>{project.role ?? "org"}</Badge>
          </div>
        </div>
        <IconButton
          icon="settings"
          aria-label="Project settings"
          onClick={() => router.push(`/projects/${slug}/settings`)}
        />
      </header>

      <div className="flex flex-col gap-6" data-shape={reading.shape}>
        <Headline reading={reading} />

        {(reading.shape === "working" || reading.shape === "unread") && (
          <StatStrip
            liveSessions={liveSessions.length}
            sessionsUnread={sessionsState.read !== "ok"}
            openRuns={liveRuns(runItems).length}
            runsUnread={runsState.read !== "ok"}
            runnersUnread={runnersState.read !== "ok"}
            activityUnread={activityState.read !== "ok"}
            busyRunners={runners.busyCount}
            onlineRunners={runners.onlineCount}
            needsYou={attention.length}
            needsYouCaption={attentionCaption(attention, attentionLeftOut)}
            oldestWait={oldestSeconds === null ? null : formatElapsed(oldestSeconds)}
            needsYouRefusal={attentionRefused}
            needsYouPending={attentionPending}
            needsYouUnread={reading.unread}
            openWork={donut.total}
            openWorkMadeOf={donut.segments.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(" · ")}
            spendTodayUsd={health?.spend24hUsd ?? 0}
            spendComparison={spendComparison(health?.spend24hUsd ?? 0, spend.total)}
            inFlightUsd={inFlight}
          />
        )}

        {reading.shape === "quiet" ? (
          // Quiet is short: the headline says nothing needs anyone, every empty section is one line,
          // and what holds data follows in one column.
          <div className="flex flex-col gap-4">
            {liveSection}
            {releaseSection}
            {metricSections}
          </div>
        ) : (
          <div className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="flex min-w-0 flex-col gap-5">
              <AttentionQueue
                items={attention}
                cut={attentionLeftOut}
                refusal={attentionRefused}
                pending={attentionPending}
                onRetry={readFailure ? attentionQ.refetch : undefined}
                shape={reading.shape}
                slug={project.slug}
                now={now}
              />
              {liveSection}
              {releaseSection}
            </div>
            <div className="flex min-w-0 flex-col gap-5">{metricSections}</div>
          </div>
        )}

        <ComingSoonNote />
      </div>
    </PageContainer>
  );
}
