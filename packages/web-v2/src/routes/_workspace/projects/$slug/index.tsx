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
// the loop moves. Its reads are the project list it is found by and the Dashboard's own four.
function ProjectOverviewPage() {
  const t = useCopy();
  const slug = useParams<{ slug: string }>()?.slug;
  const router = useRouter();
  const { ref: projectId, row, projectsQ } = useProjectRef(slug);
  const project = row && row.id === projectId ? row : undefined;

  // The page subscribes to THIS project's room so its reads refresh as work moves (ISS-379).
  useRoom(projectId ? projectRoom(projectId) : null);

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
  return (
    <PageContainer className="min-h-dvh">
      <ProjectHomeHeader project={project} onSettings={() => router.push(`/projects/${project.slug}/settings`)} />
      <ProjectDashboard projectId={project.id} slug={project.slug} />
    </PageContainer>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/")({ component: ProjectOverviewPage });
