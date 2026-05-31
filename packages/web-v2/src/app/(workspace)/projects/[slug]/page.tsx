"use client";

import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  ProjectMark,
  MonoTag,
  Badge,
  Stat,
  Kicker,
  PipelineTracker,
  ProjectLoader,
  EmptyState,
  ErrorState,
  type IconName,
} from "@/design";
import type { StageKey } from "@/design/stages";
import { useProjects, useProjectHealth } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { formatApiError } from "@/lib/api/error";

/** Map a core issue status (statusDistribution key) to a pipeline stage so the
 *  overview's PipelineTracker reflects where the project's work actually sits. */
const STATUS_TO_STAGE: Record<string, StageKey> = {
  open: "triage",
  needs_info: "triage",
  confirmed: "triage",
  waiting: "clarify",
  approved: "plan",
  in_progress: "code",
  reopen: "code",
  developed: "review",
  deploying: "test",
  testing: "test",
  tested: "test",
  pass: "release",
  staging: "release",
  released: "release",
  closed: "release",
};

function dominantStage(dist: Record<string, number>): StageKey {
  let best: { status: string; count: number } | null = null;
  for (const [status, count] of Object.entries(dist)) {
    if (!best || count > best.count) best = { status, count };
  }
  return (best && STATUS_TO_STAGE[best.status]) || "triage";
}

export default function ProjectOverviewPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const projectsQ = useProjects();
  const healthQ = useProjectHealth();

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

  const project = projectsQ.data?.find((p) => p.slug === slug);
  const health = healthQ.data?.find((h) => h.projectSlug === slug);

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

  const glyph = projectGlyph(project.id);
  const stage = health ? dominantStage(health.statusDistribution) : "triage";

  const metrics: Array<{ icon: IconName; label: string; value: string }> = [
    { icon: "inbox", label: "Active issues", value: String(health?.totalActive ?? 0) },
    { icon: "activity", label: "Throughput", value: String(health?.throughput ?? 0) },
    { icon: "clock", label: "Avg cycle time", value: health ? `${health.avgCycleTimeDays}d` : "—" },
    { icon: "alert", label: "Escalations", value: String(health?.pendingEscalations ?? 0) },
  ];

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6 flex items-center gap-4">
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(project.name)} size={48} />
        <div className="flex-1">
          <h1 className="fg-h2">{project.name}</h1>
          <div className="mt-1.5 flex items-center gap-2">
            <MonoTag>{project.slug}</MonoTag>
            <Badge tone={project.role === "owner" ? "accent" : "neutral"}>{project.role}</Badge>
          </div>
        </div>
      </header>

      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {metrics.map((m) => (
            <Card key={m.label}>
              <CardContent>
                <Stat icon={m.icon} mono={false}>
                  {m.label}
                </Stat>
                <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-fg">{m.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardContent>
            <div className="mb-4 flex items-center justify-between gap-3">
              <Kicker>Pipeline</Kicker>
              <Stat icon="pipeline" mono={false}>
                most work at {stage}
              </Stat>
            </div>
            <PipelineTracker stage={stage} status="running" variant="full" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
