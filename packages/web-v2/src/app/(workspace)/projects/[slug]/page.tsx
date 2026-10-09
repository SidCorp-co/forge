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
import { feedbackFigures, landsThisWeek, planRows, requirementsByState } from "@/features/project-dashboard/ba-derive";
import { BaFigures } from "@/features/project-dashboard/components/ba-figures";
import { LandsThisWeek } from "@/features/project-dashboard/components/plan-sections";
import { ProjectMemory } from "@/features/memory/components/project-memory";
import { ProjectOrientation } from "@/features/project-dashboard/components/project-orientation";
import { useModuleRollup } from "@/features/modules/hooks";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useComingNext, useFeedbackForecasts, useRequirementForecasts } from "@/features/forecast/hooks";
import { etaInline, etaOfScope } from "@/features/forecast/eta";
import { useFeedbackList } from "@/features/feedback/hooks";
import { useReleases } from "@/features/releases/hooks";
import { useRequirements } from "@/features/requirements/hooks";
import { useNeedsYouDecisions } from "@/features/needs-you/hooks";
import { ProjectHome } from "@/features/project-home/components/project-home";
import { ShippedRecently } from "@/features/project-status/components/shipped-recently";
import { useProjectStatus } from "@/features/project-status/hooks";
import { OnboardingHint } from "@/features/onboarding/components/onboarding-hint";
import { useProjectRef } from "@/features/projects/project-ref";
import { useOnboardingState } from "@/features/onboarding/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { canManageProject } from "@/features/projects/write-access";
import { useProjectDocument } from "@/features/project-config/hooks";
import { SystemOverviewRegion } from "@/features/workflows/components/system-overview";
import { useWorkflowTemplates, useWorkflows } from "@/features/workflows/hooks";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectOverviewPage() {
  const t = useCopy();
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug;

  const { ref: projectId, row, projectsQ } = useProjectRef(slug);
  const project = row && row.id === projectId ? row : undefined;

  // The page subscribes to THIS project's room so the reads below refresh as work moves (ISS-379).
  useRoom(projectId ? projectRoom(projectId) : null);

  // A BA or PM's page: what needs them, how requirements and feedback stand, what lands this week and
  // what is late. Every figure is a read core answers; Development's own figures live on Development.
  const decisionsQ = useNeedsYouDecisions(projectId);
  const statusQ = useProjectStatus(projectId);
  const requirementsQ = useRequirements(projectId);
  const feedbackQ = useFeedbackList(projectId);
  const releasesQ = useReleases(projectId);
  const requirementForecastsQ = useRequirementForecasts(projectId);
  const feedbackForecastsQ = useFeedbackForecasts(projectId);
  const comingQ = useComingNext(projectId);
  const workflowsQ = useWorkflows(projectId);
  const templatesQ = useWorkflowTemplates(projectId);
  const projectDocumentQ = useProjectDocument(projectId);
  const modulesQ = useModuleRollup(projectId);
  useOnboardingState(projectId);
  const clock = useEtaClock();

  if (projectsQ.isLoading || (row && !project)) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label={t("dash.loading")} />
      </div>
    );
  }

  if (projectsQ.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title={t("dash.loadFailed")} message={formatApiError(projectsQ.error)} onRetry={() => projectsQ.refetch()} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <EmptyState title={t("dash.notFound")} message={t("dash.notFoundMessage")} mascot />
      </div>
    );
  }

  const glyph = projectGlyph(project.id);
  const declared = projectDocumentQ.data?.declared ? projectDocumentQ.data.document : null;
  const describedAs = (declared?.project as { description?: unknown } | undefined)?.description;
  const production = releasesQ.data?.production;
  const productionHost = production?.ok && production.url ? production.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : null;
  const live = releasesQ.data?.releases.find((r) => r.current && r.state === "shipped");
  // the decisions only this member can make: the read the home's Needs you table and the chat share
  const decisionCount = decisionsQ.data?.total ?? 0;
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
            <Badge tone={project.role === "admin" ? "accent" : "neutral"}>{t(project.role === "admin" ? "common.role.admin" : project.role === "member" ? "common.role.member" : project.role === "viewer" ? "common.role.viewer" : "common.role.org")}</Badge>
            {decisionCount > 0 && (
              <span className="fg-caption inline-flex items-center gap-1 font-semibold" style={{ color: "var(--accent-text)" }}>
                <Icon name="inbox" size={13} />
                {t("dash.needsAttention", { count: decisionCount })}
              </span>
            )}
          </div>
        </div>
        <IconButton icon="settings" aria-label={t("dash.projectSettings")} onClick={() => router.push(`/projects/${slug}/settings`)} />
      </header>

      <div className="space-y-6">
        {/* the home opens on the conversation, with what needs you, what is running and what is at risk beside it */}
        <ProjectHome projectId={project.id} slug={project.slug} />

        {/* what the project is and where it stands comes first; the system map follows, the asks below it */}
        <ProjectOrientation
          slug={project.slug}
          description={typeof describedAs === "string" && describedAs.trim() ? describedAs : null}
          modules={modulesQ.data ? modulesQ.data.modules.filter((m) => m.parentId === null).map((m) => ({ id: m.id, name: m.name, slug: m.slug })) : null}
          now={statusQ.data?.roadmap.now ?? []}
          next={statusQ.data?.roadmap.next ?? []}
          live={live ? { version: live.version, where: productionHost } : null}
          draft={draft ? { version: draft.version, eta: (() => { const eta = etaOfScope(comingQ.data?.draft, clock); return eta ? etaInline(eta, clock) : null; })() } : null}
        />

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

        <BaFigures
          slug={project.slug}
          requirements={requirementsByState(requirementsQ.data?.requirements)}
          feedback={feedbackFigures(feedbackQ.data?.feedback, clock.now)}
          release={draft ? { version: draft.version, eta: etaOfScope(comingQ.data?.draft, clock) } : null}
          clock={clock}
        />

        <LandsThisWeek rows={landsThisWeek(rows, clock)} clock={clock} slug={project.slug} />

        <ShippedRecently shipped={statusQ.data?.shipped} slug={project.slug} clock={clock} />

        <ProjectMemory projectId={project.id} slug={project.slug} />
      </div>
    </PageContainer>
    </>
  );
}
