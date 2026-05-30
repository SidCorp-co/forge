"use client";

// Run-conversation detail (`/v2/projects/[slug]/sessions/[id]`). Resolve the
// slug → project (same pattern as the sessions index page), then render the
// shared SessionScreen for the `[id]` agent session. ISS-292.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { SessionScreen } from "@/features/session/components/session-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function SessionDetailPage() {
  const params = useParams<{ slug: string; id: string }>();
  const slug = params?.slug;
  const id = params?.id;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading session…" />
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

  return <SessionScreen sessionId={id as string} projectSlug={slug} />;
}
