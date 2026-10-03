"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { ModuleScreen } from "@/features/modules/components/module-screen";
import { formatApiError } from "@/lib/api/error";

export default function ProjectModulePage() {
  const params = useParams<{ slug: string; module: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading module…" />
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
  const project = projects?.find((p) => p.slug === params?.slug);
  if (!project || !params?.module) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Project not found" message="This project doesn't exist or you don't have access to it." />
      </div>
    );
  }
  return (
    <ModuleScreen projectId={project.id} slug={project.slug} moduleSlug={decodeURIComponent(params.module)} />
  );
}
