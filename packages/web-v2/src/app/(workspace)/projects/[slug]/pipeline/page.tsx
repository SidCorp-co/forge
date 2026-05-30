"use client";

// Project-tier Pipeline kanban (`/v2/projects/[slug]/pipeline`, ISS-295).
// Resolve slug → projectId via the project console list (same pattern as the
// issues/sessions pages), then render the board screen.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { PipelineBoard } from "@/features/pipeline/components/pipeline-board";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectPipelinePage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading pipeline…" />
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

  return <PipelineBoard scope={{ projectId: project.id, slug: project.slug }} />;
}
