"use client";

// Project-tier Runners view (`/projects/[slug]/runners`). Project-centric device
// control: repo URL + deploy key, assign devices, live provision stepper. The
// workspace `/runners` page stays the device-global roll-up. Resolve slug →
// project (issues-page template), then render the scoped screen.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { ProjectRunnersScreen } from "@/features/runners/components/project-runners-screen";
import { formatApiError } from "@/lib/api/error";

export default function ProjectRunnersPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading runners…" />
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

  return <ProjectRunnersScreen projectId={project.id} canEdit={project.role === "admin"} />;
}
