"use client";

// Project-tier Library view (`/projects/[slug]/library`, Concept C) — merged
// Knowledge + Memory + Skills. Resolve slug → project (issues-page template),
// then render the scoped tabbed shell. Ingest / registration mutations are
// owner/admin-only, so pass `canManage` from the membership role.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { LibraryScreen } from "@/features/library/components/library-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

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

  const canManage = project.role === "admin";
  return <LibraryScreen scope={{ projectId: project.id, canManage }} />;
}
