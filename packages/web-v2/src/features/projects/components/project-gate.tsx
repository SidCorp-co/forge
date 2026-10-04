"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";

export function ProjectGate({ label, children }: { label: string; children: (p: ProjectListItem) => React.ReactNode }) {
  const params = useParams<{ slug: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  const project = projects?.find((p) => p.slug === params?.slug);
  if (!isLoading && !isError && project) return <>{children(project)}</>;
  return (
    <div className="grid min-h-[60vh] place-items-center">
      {isLoading ? (
        <ProjectLoader label={label} />
      ) : isError ? (
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      ) : (
        <ErrorState title="Project not found" message="This project doesn't exist or you don't have access to it." />
      )}
    </div>
  );
}
