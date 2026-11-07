import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { useProjectsAttention } from "@/features/activity";
import { useOrgScopedProjects } from "@/features/projects";
import { ProjectsConsole } from "@/features/projects/components/projects-console";

// a project reads Attention where its Dashboard shows a Needs you or a Stuck group, from the Dashboard's own reading (ISS-1072)
function ProjectsConsolePage() {
  const { projects } = useOrgScopedProjects();
  const attention = useProjectsAttention(projects.map((p) => p.id));
  return (
    <Suspense fallback={null}>
      <ProjectsConsole attention={attention} />
    </Suspense>
  );
}

export const Route = createFileRoute("/_workspace/projects/")({ component: ProjectsConsolePage });
