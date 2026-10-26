"use client";

// Project-tier Library view (`/projects/[slug]/library`, Concept C) — merged
// Knowledge + Skills + Updates. Resolve slug → project (issues-page template),
// then render the scoped tabbed shell. Ingest / registration mutations are
// owner/admin-only, so pass `canManage` from the membership role.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { LibraryScreen } from "@/features/library/components/library-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { ProjectMissing } from "@/features/projects/components/project-missing";

export default function ProjectLibraryPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading library…" />
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
  return <LibraryScreen scope={{ projectId: project.id, canManage }} />;
}
