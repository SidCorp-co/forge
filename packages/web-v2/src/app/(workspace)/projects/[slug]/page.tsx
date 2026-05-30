"use client";

import { useParams } from "next/navigation";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  ProjectMark,
  MonoTag,
  Badge,
  Stat,
  PipelineTracker,
  ProjectLoader,
  EmptyState,
  ErrorState,
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
        />
      </div>
    );
  }

  const glyph = projectGlyph(project.id);
  const stage = health ? dominantStage(health.statusDistribution) : "triage";
  const dist = health ? Object.entries(health.statusDistribution) : [];

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-8">
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent>
            <p className="fg-caption">Active issues</p>
            <p className="mt-1 font-mono text-2xl font-bold text-fg">{health?.totalActive ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="fg-caption">Throughput</p>
            <p className="mt-1 font-mono text-2xl font-bold text-fg">{health?.throughput ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="fg-caption">Avg cycle</p>
            <p className="mt-1 font-mono text-2xl font-bold text-fg">
              {health ? `${health.avgCycleTimeDays}d` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="fg-caption">Escalations</p>
            <p className="mt-1 font-mono text-2xl font-bold text-fg">{health?.pendingEscalations ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Pipeline</CardTitle>
          <Stat icon="pipeline" mono={false}>
            most work at {stage}
          </Stat>
        </CardHeader>
        <CardContent>
          <PipelineTracker stage={stage} status="running" variant="full" />
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Status distribution</CardTitle>
        </CardHeader>
        <CardContent>
          {dist.length === 0 ? (
            <p className="fg-body-sm">No active issues.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {dist.map(([status, count]) => (
                <span key={status} className="flex items-center gap-2">
                  <MonoTag>{status}</MonoTag>
                  <span className="font-mono text-sm text-muted">{count}</span>
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
