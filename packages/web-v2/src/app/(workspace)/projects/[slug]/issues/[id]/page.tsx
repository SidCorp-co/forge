"use client";

// Project-tier Issue detail (`/projects/[slug]/issues/[id]`). Resolve slug →
// projectId via the project console list, read `id` from the route, render the
// detail screen.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { ProjectMissing } from "@/features/projects/components/project-missing";

export default function ProjectIssueDetailPage() {
  const params = useParams<{ slug: string; id: string }>();
  const slug = params?.slug;
  const id = params?.id;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading issue…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      </div>
    );
  }

  const project = projects?.find((p) => p.slug === slug);
  // The route always names an issue: what can be missing here is the project, said as its Pipeline page says it (ISS-1228 r27).
  if (!project || !id) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectMissing slug={slug} />
      </div>
    );
  }

  return (
      <IssueDetailScreen projectId={project.id} slug={project.slug} id={id} />
  );
}
