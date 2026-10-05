"use client";

import { WorkflowsScreen } from "@/features/workflows/components/workflows-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { canManageProject } from "@/features/projects/write-access";

export default function ProjectWorkflowsPage() {
  return (
    <ProjectGate label="loading workflows…">
      {(p) => <WorkflowsScreen projectId={p.id} slug={p.slug} projectName={p.name} canEdit={canManageProject(p.role)} />}
    </ProjectGate>
  );
}
