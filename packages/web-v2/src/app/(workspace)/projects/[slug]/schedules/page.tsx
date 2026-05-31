"use client";

// Project-tier Schedules view (`/v2/projects/[slug]/schedules`). Resolve slug →
// project via the console list (issues-page template), then render the scoped
// screen. Toggle/run are owner/admin-only, so pass `canManage` from the role.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { SchedulesScreen } from "@/features/schedules/components/schedules-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectSchedulesPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading schedules…" />
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

  const canManage = project.role === "owner" || project.role === "admin";
  return <SchedulesScreen scope={{ projectId: project.id, canManage }} />;
}
