import { createFileRoute } from "@tanstack/react-router";
import { EmptyState, ErrorState, PageContainer, ProjectLoader } from "@/design";
import { ProjectDashboard } from "@/features/project-dashboard";
import { ProjectHomeHeader } from "@/features/project-home";
import { useProjectRef } from "@/features/projects/project-ref";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useParams, useRouter } from "@/lib/navigation/router";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";

// The project Dashboard (ISS-1067): the one-project view of Activity, what needs the person and whether
// the loop moves. Its reads are the project list it is found by and the Dashboard's own four, which
// leave by the URL's slug at once rather than waiting on the list (`useProjectRef`).
function ProjectOverviewPage() {
  const t = useCopy();
  const slug = useParams<{ slug: string }>()?.slug;
  const router = useRouter();
  const { ref: projectId, row, projectsQ } = useProjectRef(slug);
  const project = row && row.id === projectId ? row : undefined;

  // The page subscribes to THIS project's room so its reads refresh as work moves (ISS-379).
  useRoom(projectId ? projectRoom(projectId) : null);

  if (projectsQ.isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title={t("dash.loadFailed")} message={formatApiError(projectsQ.error)} onRetry={() => void projectsQ.refetch()} />
      </div>
    );
  }
  if (!projectId || !slug) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        {projectsQ.isLoading ? <ProjectLoader label={t("dash.loading")} /> : <EmptyState title={t("dash.notFound")} message={t("dash.notFoundMessage")} mascot />}
      </div>
    );
  }
  if (projectsQ.data && !project && !row) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <EmptyState title={t("dash.notFound")} message={t("dash.notFoundMessage")} mascot />
      </div>
    );
  }
  return (
    <PageContainer className="min-h-dvh">
      {project ? <ProjectHomeHeader project={project} onSettings={() => router.push(`/projects/${project.slug}/settings`)} /> : null}
      <ProjectDashboard projectId={projectId} slug={slug} />
    </PageContainer>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/")({ component: ProjectOverviewPage });
