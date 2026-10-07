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
  PageTitle,
  ProjectLoader,
  ProjectMark,
} from "@/design";
import { baNeedsYou, feedbackFigures, landsThisWeek, lateRows, planRows, requirementsByState } from "@/features/project-dashboard/ba-derive";
import { AttentionQueue } from "@/features/project-dashboard/components/attention-queue";
import { BaFigures } from "@/features/project-dashboard/components/ba-figures";
import { LandsThisWeek, LateItems } from "@/features/project-dashboard/components/plan-sections";
import { useComingNext, useEtaClock, useFeedbackForecasts, useRequirementForecasts } from "@/features/forecast/hooks";
import { etaOfScope } from "@/features/forecast/eta";
import { useFeedbackList } from "@/features/feedback/hooks";
import { useReleases } from "@/features/releases/hooks";
import { useRequirements } from "@/features/requirements/hooks";
import { useNeedsYou } from "@/features/needs-you/hooks";
import { OnboardingHint } from "@/features/onboarding/components/onboarding-hint";
import { useProjects } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { canManageProject } from "@/features/projects/write-access";
import { useProjectDocument } from "@/features/project-config/hooks";
import { SystemOverviewRegion } from "@/features/workflows/components/system-overview";
import { useWorkflowTemplates, useWorkflows } from "@/features/workflows/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";

export default function ProjectOverviewPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug;

  const projectsQ = useProjects();
  const project = projectsQ.data?.find((p) => p.slug === slug);
  const projectId = project?.id;

  // The page subscribes to THIS project's room so the reads below refresh as work moves (ISS-379).
  useRoom(projectId ? projectRoom(projectId) : null);

  // A BA or PM's page: what needs them, how requirements and feedback stand, what lands this week and
  // what is late. Every figure is a read core answers; Development's own figures live on Development.
  const needsYouQ = useNeedsYou(projectId);
  const requirementsQ = useRequirements(projectId);
  const feedbackQ = useFeedbackList(projectId);
  const releasesQ = useReleases(projectId);
  const requirementForecastsQ = useRequirementForecasts(projectId);
  const feedbackForecastsQ = useFeedbackForecasts(projectId);
  const comingQ = useComingNext(projectId);
  const workflowsQ = useWorkflows(projectId);
  const templatesQ = useWorkflowTemplates(projectId);
  const projectDocumentQ = useProjectDocument(projectId);
  const clock = useEtaClock(projectId);

  if (projectsQ.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading project…" />
      </div>
    );
  }

  if (projectsQ.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Couldn't load project" message={formatApiError(projectsQ.error)} onRetry={() => projectsQ.refetch()} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <EmptyState title="Project not found" message="This project doesn't exist or you don't have access to it." mascot />
      </div>
    );
  }

  const glyph = projectGlyph(project.id);
  const attention = baNeedsYou(needsYouQ.data?.items ?? []);
  const draft = releasesQ.data?.releases.find((r) => r.state === "draft");
  const rows = planRows(
    {
      slug: project.slug,
      requirements: requirementForecastsQ.data,
      feedback: feedbackForecastsQ.data,
      feedbackTitles: new Map((feedbackQ.data?.feedback ?? []).map((f) => [f.key, f.title])),
      release: { summary: draft, scope: comingQ.data?.draft },
    },
    clock,
  );

  return (
    <>
    {/* onboarding is offered, never required: one line above the dashboard, gone once its designs are approved */}
    <OnboardingHint projectId={project.id} projectName={project.name} />
    <PageContainer className="min-h-dvh">
      <header className="mb-6 flex items-center gap-4">
        <ProjectMark tint={glyph.tint} ink={glyph.ink} initials={projectInitials(project.name)} size={48} />
        <div className="flex-1">
          <PageTitle className="fg-h2">{project.name}</PageTitle>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <MonoTag>{project.slug}</MonoTag>
            <Badge tone={project.role === "admin" ? "accent" : "neutral"}>{project.role ?? "org"}</Badge>
            {attention.length > 0 && (
              <span className="fg-caption inline-flex items-center gap-1 font-semibold" style={{ color: "var(--accent-text)" }}>
                <Icon name="inbox" size={13} />
                needs attention {attention.length}
              </span>
            )}
          </div>
        </div>
        <IconButton icon="settings" aria-label="Project settings" onClick={() => router.push(`/projects/${slug}/settings`)} />
      </header>

      <div className="space-y-6">
        <BaFigures
          slug={project.slug}
          requirements={requirementsByState(requirementsQ.data?.requirements)}
          feedback={feedbackFigures(feedbackQ.data?.feedback, clock.now)}
          release={draft ? { version: draft.version, eta: etaOfScope(comingQ.data?.draft, clock) } : null}
          clock={clock}
        />

        <AttentionQueue items={attention} slug={project.slug} />

        <div className="grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-2">
          <LandsThisWeek rows={landsThisWeek(rows, clock)} clock={clock} />
          <LateItems rows={lateRows(rows)} />
        </div>

        {workflowsQ.data && workflowsQ.data.workflows.length > 0 ? (
          <SystemOverviewRegion
            records={workflowsQ.data.workflows}
            projectId={project.id}
            templates={(templatesQ.data?.templates ?? []).map((t) => t.template)}
            slug={project.slug}
            projectName={project.name}
            projectDocument={projectDocumentQ.data}
            canEdit={canManageProject(project.role)}
            variant="compact"
          />
        ) : null}
      </div>
    </PageContainer>
    </>
  );
}
