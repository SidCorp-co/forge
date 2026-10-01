"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { formatApiError } from "@/lib/api/error";

export default function ProjectReleasesPage() {
  const params = useParams<{ slug: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading releases…" />
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
  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Project not found" message="This project doesn't exist or you don't have access to it." />
      </div>
    );
  }
  return <ReleasesScreen projectId={project.id} isAdmin={project.role === "admin"} />;
}
