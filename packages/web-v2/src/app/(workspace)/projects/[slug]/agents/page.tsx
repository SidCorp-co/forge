"use client";

// Project-tier Agents view (`/projects/[slug]/agents`, Concept C) — merged
// Sessions + Chat. Resolve slug → project (issues-page template), then render
// the scoped shell.
import { useParams } from "next/navigation";
import { ProjectLoader } from "@/design";
import { AgentsScreen } from "@/features/agents/components/agents-screen";
import { useProjects } from "@/features/projects/hooks";
import { ProjectMissing, ProjectsUnread } from "@/features/projects/components/project-missing";

export default function ProjectAgentsPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const { data: projects, isLoading, isError, error } = useProjects();

  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading agents…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectsUnread error={error} />
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

  return <AgentsScreen scope={{ projectId: project.id, slug: project.slug }} />;
}
