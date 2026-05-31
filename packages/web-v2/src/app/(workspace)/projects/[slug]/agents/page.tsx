"use client";

// Project-tier Agents view (`/v2/projects/[slug]/agents`, Concept C) — merged
// Sessions + Chat. Resolve slug → project (issues-page template), then render
// the scoped shell.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { AgentsScreen } from "@/features/agents/components/agents-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectAgentsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading agents…" />
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

  return <AgentsScreen scope={{ projectId: project.id }} />;
}
