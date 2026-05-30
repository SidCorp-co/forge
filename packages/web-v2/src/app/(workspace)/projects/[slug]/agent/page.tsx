"use client";

// Single-assistant Chat (`/v2/projects/[slug]/agent`). Resolve the slug →
// project, then render the lighter ChatScreen (reuses Conversation + Composer).
// ISS-292.
import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { ChatScreen } from "@/features/session/components/chat-screen";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";

export default function ProjectAgentChatPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading chat…" />
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

  return <ChatScreen projectId={project.id} />;
}
