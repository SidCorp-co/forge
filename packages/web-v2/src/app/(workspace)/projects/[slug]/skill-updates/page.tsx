"use client";

import { useParams } from "next/navigation";
import { ErrorState, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { SkillUpdatesScreen } from "@/features/skill-updates/components/skill-updates-screen";
import { formatApiError } from "@/lib/api/error";

// cm:why the menu no longer shows skills, but a skill change routed to a human gate still needs a person's decision, so its review keeps this page, reached from the gate's notification
export default function ProjectSkillUpdatesPage() {
  const params = useParams<{ slug: string }>();
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading skill updates…" />
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
  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState title="Project not found" message="This project doesn't exist or you don't have access to it." />
      </div>
    );
  }
  return <SkillUpdatesScreen scope={{ projectId: project.id, canManage: project.role === "admin" }} />;
}
