"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { formatApiError } from "@/lib/api/error";

export default function ProjectRequirementPage() {
  const params = useParams<{ slug: string; requirement: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading requirement…" />
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
  if (!project || !params?.requirement) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Project not found" message="This project doesn't exist or you don't have access to it." />
      </div>
    );
  }
  return (
    <RequirementScreen projectId={project.id} slug={project.slug} reqKey={decodeURIComponent(params.requirement)} />
  );
}
