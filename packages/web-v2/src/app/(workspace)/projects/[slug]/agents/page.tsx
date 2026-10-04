"use client";

import { AgentsScreen } from "@/features/agents/components/agents-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { canWriteProject } from "@/features/projects/write-access";

export default function ProjectAgentsPage() {
  return (
    <ProjectGate label="loading agents…">
      {(p) => <AgentsScreen access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role) }} />}
    </ProjectGate>
  );
}
