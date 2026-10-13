import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { ProjectsConsole } from "@/features/projects/components/projects-console";

function ProjectsConsolePage() {
  return (
    <Suspense fallback={null}>
      <ProjectsConsole />
    </Suspense>
  );
}

export const Route = createFileRoute("/_workspace/projects/")({ component: ProjectsConsolePage });
