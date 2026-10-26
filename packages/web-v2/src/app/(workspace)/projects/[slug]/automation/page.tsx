"use client";

// Project-tier Automation view (`/projects/[slug]/automation`, Concept C) —
// merged Schedules + PM. Resolve slug → project (issues-page template), then
// render the scoped tabbed shell. Schedule toggle/run are owner/admin-only, so
// pass `canManage` from the membership role.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { AutomationScreen } from "@/features/automation/components/automation-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { ProjectMissing } from "@/features/projects/components/project-missing";

export default function ProjectAutomationPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading automation…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState level={1} message={formatApiError(error)} onRetry={() => refetch()} />
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

  const canManage = project.role === "admin";
  return <AutomationScreen scope={{ projectId: project.id, canManage }} />;
}
