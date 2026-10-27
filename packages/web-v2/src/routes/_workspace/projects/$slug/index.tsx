import { createFileRoute } from "@tanstack/react-router";
import { useParams, useRouter } from "@/lib/navigation/router";
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
} from "@/design";
import { type FeedbackFigures, feedbackFigures, landsThisWeek, planRows, requirementsByState } from "@/features/project-dashboard/ba-derive";
import type { ProjectStatus } from "@forge/contracts/project-status";
import { BaFigures } from "@/features/project-dashboard/components/ba-figures";
import { HeadlineFigures, type HeadlineFiguresProps } from "@/features/project-dashboard/components/headline-figures";
import { ProjectHealthFigures, useHealthWindow } from "@/features/project-dashboard/components/health-panel";
import { useProjectHealth } from "@/features/project-dashboard/health-api";
import { LandsThisWeek } from "@/features/project-dashboard/components/plan-sections";
import { ProjectMemory } from "@/features/memory";
import { ProjectOrientation } from "@/features/project-dashboard/components/project-orientation";
import { useModuleRollup } from "@/features/modules";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { useComingNext, useFeedbackForecasts, useRequirementForecasts } from "@/features/forecast";
import { type Eta, type EtaClock, etaInline, etaOfScope } from "@/features/forecast";
import { useFeedbackList } from "@/features/feedback";
import { useReleases } from "@/features/releases";
import { useRequirements } from "@/features/requirements/hooks";
import { useNeedsYouDecisions } from "@/features/needs-you";
import { atRiskCount, ProjectHome } from "@/features/project-home";
import { useStewardBudget } from "@/features/standing";
import { useProjectStatus } from "@/features/project-status/hooks";
import { OnboardingHint } from "@/features/onboarding";
import { useProjectRef } from "@/features/projects/project-ref";
import { useOnboardingState } from "@/features/onboarding";
import { projectGlyph, projectInitials } from "@/features/projects";
import { canManageProject } from "@/features/projects";
import { useProjectDocument } from "@/features/project-config";
import { SystemOverviewRegion } from "@/features/workflows/components/system-overview";
import { useWorkflowTemplates, useWorkflows } from "@/features/workflows/hooks";
import { formatApiError } from "@/lib/api/error";
import { formatDate } from "@/lib/i18n/format";
import { feedbackListHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { statusReportHref } from "@/lib/routes/status";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { useCopy } from "@/lib/i18n/interface-language";

/** The project's business modules, the roots of its module tree; null while they are read. */
const rootModules = (modules: { id: string; name: string; slug: string | null; parentId: string | null }[] | undefined) =>
  modules ? modules.filter((m) => m.parentId === null).map((m) => ({ id: m.id, name: m.name, slug: m.slug })) : null;

/** The headline row's figures from the reads the page already holds; a figure still being read is null. */
function headlineOf(r: { slug: string; needsYou: number | null; status: ProjectStatus | undefined; feedback: FeedbackFigures; draft: { version: string; eta: Eta | null } | null; clock: EtaClock }): HeadlineFiguresProps {
  const { slug, status, clock } = r;
  const next = status?.nextRelease.version ?? null;
  const shipped = status?.shipped.latest ?? null;
  const eta = r.draft?.eta && next === r.draft.version ? etaInline(r.draft.eta, clock) : null;
  return {
    needsYou: r.needsYou,
    running: status ? status.inFlight.runningCount : null,
    atRisk: status ? atRiskCount(status, slug) : null,
    feedback: { open: r.feedback.open, untriaged: r.feedback.untriaged, href: feedbackListHref(slug) },
    next: next ? { version: next, eta, href: releaseHref(slug, next) } : null,
    live: shipped ? { version: shipped.version, at: formatDate(shipped.releasedAt, clock.lang, clock.timeZone), href: statusReportHref(slug) } : null,
  };
}

function ProjectOverviewPage() {
  const t = useCopy();
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params?.slug;

  const { ref: projectId, row, projectsQ } = useProjectRef(slug);
  const project = row && row.id === projectId ? row : undefined;

  // The page subscribes to THIS project's room so the reads below refresh as work moves (ISS-379).
  useRoom(projectId ? projectRoom(projectId) : null);

  // A BA or PM's page, figures first: one number per thing they check, the pictures of requirements,
  // feedback and the next release, what the project is, then what needs them, what runs and what is
  // at risk, delivery's health and what lands this week. Every figure is a read core answers;
  // Development's own figures live on Development.
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
  // the health panel and the steward's budget line draw only once the project is known; their reads
  // leave now, by the slug, with the rest
  useProjectHealth(projectId, useHealthWindow().days);
  useStewardBudget(projectId);
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
        <ErrorState title={t("dash.loadFailed")} message={formatApiError(projectsQ.error)} onRetry={() => void projectsQ.refetch()} />
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
  const status = statusQ.data;
  // the decisions only this member can make: the read the home's Needs you table and the chat share
  const decisionCount = decisionsQ.data?.total ?? 0;
  const draft = releasesQ.data?.releases.find((r) => r.state === "draft");
  const draftEta = etaOfScope(comingQ.data?.draft, clock);
  const nextVersion = status?.nextRelease.version ?? null;
  const feedback = feedbackFigures(feedbackQ.data?.feedback);
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
  const weekRows = landsThisWeek(rows, clock);

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
          </div>
        </div>
        <IconButton icon="settings" aria-label={t("dash.projectSettings")} onClick={() => router.push(`/projects/${slug}/settings`)} />
      </header>

      <div className="space-y-8">
        <HeadlineFigures {...headlineOf({ slug: project.slug, needsYou: decisionsQ.data ? decisionCount : null, status, feedback, draft: draft ? { version: draft.version, eta: draftEta } : null, clock })} />

        <BaFigures
          slug={project.slug}
          requirements={requirementsByState(requirementsQ.data?.requirements)}
          criteria={status ? { proven: status.requirements.proven, total: status.requirements.total } : null}
          feedback={feedback}
          release={status && nextVersion ? { version: nextVersion, progress: status.nextRelease.progress } : null}
        />

        {/* what the project is and where it stands, before the asks: the journey walk's first finding */}
        <ProjectOrientation
          slug={project.slug}
          description={typeof describedAs === "string" && describedAs.trim() ? describedAs : null}
          modules={rootModules(modulesQ.data?.modules)}
          now={status?.roadmap.now ?? []}
          next={status?.roadmap.next ?? []}
        />

        {/* what needs you, with what is running and what is at risk beside it; chat opens from Ask Agent */}
        <ProjectHome projectId={project.id} slug={project.slug} />

        <ProjectHealthFigures projectId={project.id} />

        {weekRows.length > 0 ? <LandsThisWeek rows={weekRows} clock={clock} slug={project.slug} /> : null}

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

        <ProjectMemory projectId={project.id} slug={project.slug} />
      </div>
    </PageContainer>
    </>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/")({ component: ProjectOverviewPage });
