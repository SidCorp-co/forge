"use client";

// Project-tier Pipeline page (`/projects/[slug]/pipeline`, ISS-1228): live sessions and holds.
// Resolve slug → projectId via the project console list (same pattern as the
// issues/sessions pages), then render the screen.
import { useParams } from "next/navigation";
import { ProjectLoader } from "@/design";
import { PipelineScreen } from "@/features/pipeline/components/pipeline-screen";
import { useProjects } from "@/features/projects/hooks";
import { ProjectMissing, ProjectsUnread } from "@/features/projects/components/project-missing";

export default function ProjectPipelinePage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error } = useProjects();

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
        <ProjectsUnread error={error} />
      </div>
    );
  }

  const project = projects?.find((p) => p.slug === slug);
  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectMissing slug={slug} />
      </div>
    );
  }

  return <PipelineScreen scope={{ projectId: project.id, slug: project.slug }} />;
}
