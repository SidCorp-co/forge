"use client";

// Project-tier Memory view (`/v2/projects/[slug]/memory`). Resolve slug →
// project (issues-page template) then render the scoped screen. Read-only, so
// no `canManage` is needed.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { MemoryScreen } from "@/features/memory/components/memory-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectMemoryPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading memory…" />
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

  return <MemoryScreen scope={{ projectId: project.id }} />;
}
