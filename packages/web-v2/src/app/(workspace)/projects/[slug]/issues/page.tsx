"use client";

// Project-tier Issues view (`/projects/[slug]/issues`). Resolve slug →
// projectId via the project console list (same pattern as the sessions page),
// then render the scoped screen. NavRail `proj-issues` is wired in the
// workspace layout.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { IssuesScreen } from "@/features/issues/components/issues-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectIssuesPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading issues…" />
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
  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          title="Project not found"
          message="This project doesn't exist or you don't have access to it."
        />
      </div>
    );
  }

  return <IssuesScreen scope={{ projectId: project.id, slug: project.slug }} />;
}
