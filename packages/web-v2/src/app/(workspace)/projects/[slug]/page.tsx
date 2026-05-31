"use client";

import { useParams, useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  ProjectMark,
  MonoTag,
  Badge,
  Stat,
  Kicker,
  IconButton,
  ProjectLoader,
  EmptyState,
  ErrorState,
  type IconName,
} from "@/design";
import { STAGES, stageColor, type StageKey } from "@/design/stages";
import { statusToStage } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { useProjects, useProjectHealth } from "@/features/projects/hooks";
import { formatCycleTime } from "@/features/projects/derive";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { formatApiError } from "@/lib/api/error";

/** Fold a status→count distribution into the 7 pipeline stages (A4: reuse the
 *  single `statusToStage` source of truth instead of a duplicated local map). */
function stageDistribution(dist: Record<string, number>): { stage: StageKey; count: number }[] {
  const byStage = new Map<StageKey, number>(STAGES.map((s) => [s.key, 0]));
  for (const [status, count] of Object.entries(dist)) {
    const stage = statusToStage(status as IssueStatus);
    byStage.set(stage, (byStage.get(stage) ?? 0) + count);
  }
  return STAGES.map((s) => ({ stage: s.key, count: byStage.get(s.key) ?? 0 }));
}

export default function ProjectOverviewPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
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
  const stages = health ? stageDistribution(health.statusDistribution) : [];
  const stageTotal = stages.reduce((n, s) => n + s.count, 0);

  // Caption clarifies the timeframe / definition behind each number so the
  // workspace, card, and overview all read consistently (ISS-308 B2/B3).
  const metrics: Array<{ icon: IconName; label: string; value: string; caption?: string }> = [
    {
      icon: "inbox",
      label: "Active issues",
      value: String(health?.totalActive ?? 0),
      caption: "in-flight (not closed)",
    },
    {
      icon: "activity",
      label: "Throughput",
      value: String(health?.throughput ?? 0),
      caption: "resolved · last 7 days",
    },
    {
      icon: "clock",
      label: "Avg cycle time",
      value: formatCycleTime(health?.avgCycleTimeDays),
      caption: "created → resolved · 7d",
    },
    {
      icon: "alert",
      label: "Escalations",
      value: String(health?.pendingEscalations ?? 0),
      caption: "awaiting info",
    },
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
        {/* Gear affordance → per-project settings (ISS-316). The project tier is
            fixed at 6 flat rail items, so settings attaches here (and ⌘K) rather
            than as a 7th rail row. */}
        <IconButton
          icon="settings"
          aria-label="Project settings"
          onClick={() => router.push(`/projects/${slug}/settings`)}
        />
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
                {m.caption && <p className="fg-caption mt-0.5 text-subtle">{m.caption}</p>}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Work distribution — how the project's issues are spread across the
            seven stages RIGHT NOW. Deliberately NOT the sequential
            PipelineTracker (ISS-308 A3): a static status snapshot rendered as a
            run timeline read as "the pipeline finished" (e.g. closed-heavy
            projects showed triage→release all green). A labelled bar per stage
            can't be mistaken for one completed run. */}
        <Card>
          <CardContent>
            <div className="mb-4 flex items-center justify-between gap-3">
              <Kicker>Work distribution</Kicker>
              <Stat icon="list" mono={false}>
                {stageTotal} issue{stageTotal === 1 ? "" : "s"} by stage
              </Stat>
            </div>
            {stageTotal === 0 ? (
              <p className="fg-body-sm text-muted">No issues to distribute yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
                {stages.map((s) => {
                  const pct = stageTotal > 0 ? (s.count / stageTotal) * 100 : 0;
                  return (
                    <div key={s.stage}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="fg-caption font-mono lowercase text-muted">{s.stage}</span>
                        <span className="font-mono text-sm font-bold tabular-nums text-fg">
                          {s.count}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-[var(--paper-200)]">
                        <div
                          className="h-full rounded-pill"
                          style={{ width: `${pct}%`, background: stageColor(s.stage) }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
