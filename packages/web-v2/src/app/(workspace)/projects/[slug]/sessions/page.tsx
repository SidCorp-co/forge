"use client";

// Project-tier Sessions index (`/v2/projects/[slug]/sessions`). Resolve the
// slug → projectId via the project console list (same pattern as the project
// overview page), then scope the shared screen.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectSessionsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading sessions…" />
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

  return <SessionsScreen scope={{ projectId: project.id }} />;
}
