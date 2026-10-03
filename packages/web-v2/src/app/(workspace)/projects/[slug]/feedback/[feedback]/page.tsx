"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { FeedbackItemScreen } from "@/features/feedback/components/feedback-item-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectFeedbackItemPage() {
  const params = useParams<{ slug: string; feedback: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading feedback…" />
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
  const project = projects?.find((p) => p.slug === params?.slug);
  if (!project || !params?.feedback) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Project not found" message="This project doesn't exist or you don't have access to it." />
      </div>
    );
  }
  return <FeedbackItemScreen projectId={project.id} slug={project.slug} fbKey={decodeURIComponent(params.feedback)} />;
}
