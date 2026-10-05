"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";

const PROJECT_NOT_FOUND = {
  title: "Project not found",
  message: "This project doesn't exist or you don't have access to it.",
};

export function ProjectGate({
  label,
  notFound = PROJECT_NOT_FOUND,
  children,
}: {
  label: string;
  notFound?: { title: string; message: string };
  children: (p: ProjectListItem) => React.ReactNode;
}) {
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
        <ErrorState title={notFound.title} message={notFound.message} />
      )}
    </div>
  );
}
