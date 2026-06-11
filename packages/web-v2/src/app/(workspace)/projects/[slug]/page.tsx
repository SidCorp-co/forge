"use client";

import { useParams, useRouter } from "next/navigation";
import {
  Badge,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  MonoTag,
  PageContainer,
  ProjectLoader,
  ProjectMark,
} from "@/design";
import { AttentionQueue } from "@/features/project-dashboard/components/attention-queue";
import { KpiBand } from "@/features/project-dashboard/components/kpi-band";
import { LiveRunsCard } from "@/features/project-dashboard/components/live-runs-card";
import { RunnersCard } from "@/features/project-dashboard/components/runners-card";
import { SchedulesCard } from "@/features/project-dashboard/components/schedules-card";
import { SpendCard } from "@/features/project-dashboard/components/spend-card";
import { StatusDonut } from "@/features/project-dashboard/components/status-donut";
import {
  inFlightSpend,
  liveRuns,
  projectAttention,
  runnersSummary,
  spendByStage,
  statusDonut,
  upcomingSchedules,
} from "@/features/project-dashboard/derive";
import { useAttention } from "@/features/attention/hooks";
import { useProjectRuns, useStepDurations } from "@/features/pipeline/hooks";
import { useProjectHealth, useProjects } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { useDevices } from "@/features/runners/hooks";
import { useSchedules } from "@/features/schedules/hooks";
import { useQueueStats } from "@/features/sessions/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";

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
  const durationsQ = useStepDurations({ days: 7, projectId });
  const devicesQ = useDevices();
  const queueQ = useQueueStats(projectId);
  const schedulesQ = useSchedules(projectId);

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

  const attention = projectAttention(attentionQ.view, project.slug, health?.blockers);
  const runItems = runsQ.data?.items;
  const runsLive = liveRuns(runItems);
  const inFlight = inFlightSpend(runItems);
  const runners = runnersSummary(devicesQ.data, queueQ.data);
  const donut = statusDonut(health?.statusDistribution);
  const spend = spendByStage(durationsQ.data);
  const schedules = upcomingSchedules(schedulesQ.data);

  return (
    <PageContainer className="min-h-dvh">
      <header className="mb-6 flex items-center gap-4">
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(project.name)} size={48} />
        <div className="flex-1">
          <h1 className="fg-h2">{project.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <MonoTag>{project.slug}</MonoTag>
            <Badge tone={project.role === "admin" ? "accent" : "neutral"}>{project.role ?? "org"}</Badge>
            {runsLive.length > 0 && (
              <span
                className="fg-caption inline-flex items-center gap-1.5 font-semibold"
                style={{ color: "var(--cobalt-700)" }}
              >
                <span className="size-1.5 rounded-full bg-[var(--cobalt-500)] forge-pulse" />
                {runsLive.length} {runsLive.length === 1 ? "run" : "runs"} live
              </span>
            )}
            {attention.length > 0 && (
              <span
                className="fg-caption inline-flex items-center gap-1 font-semibold"
                style={{ color: "var(--accent-text)" }}
              >
                <Icon name="inbox" size={13} />
                needs attention {attention.length}
              </span>
            )}
          </div>
        </div>
        {/* Gear affordance → per-project settings (ISS-316). */}
        <IconButton
          icon="settings"
          aria-label="Project settings"
          onClick={() => router.push(`/projects/${slug}/settings`)}
        />
      </header>

      <div className="space-y-4">
        <KpiBand
          liveRuns={runsLive.length}
          busyRunners={runners.busyCount}
          onlineRunners={runners.onlineCount}
          needsYou={attention.length}
          openIssues={health?.totalActive ?? donut.total}
          activeStages={donut.activeStageCount}
          spendTodayUsd={health?.spend24hUsd ?? 0}
          inFlightUsd={inFlight}
        />

        <AttentionQueue items={attention} now={now} />

        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          <LiveRunsCard runs={runsLive} slug={project.slug} />
          <StatusDonut data={donut} />
          <SpendCard data={spend} inFlightUsd={inFlight} />
          <RunnersCard summary={runners} slug={project.slug} />
          <SchedulesCard rows={schedules} now={now} />
        </div>
      </div>
    </PageContainer>
  );
}
