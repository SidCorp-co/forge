"use client";

// Project-tier Skills view (`/v2/projects/[slug]/skills`). Resolve slug →
// project via the console list (same template as the issues page), then render
// the scoped screen. Registration mutations are owner/admin-only, so we pass
// `canManage` derived from the membership role.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { SkillsScreen } from "@/features/skills/components/skills-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectSkillsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading skills…" />
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
  return <SkillsScreen scope={{ projectId: project.id, canManage }} />;
}
