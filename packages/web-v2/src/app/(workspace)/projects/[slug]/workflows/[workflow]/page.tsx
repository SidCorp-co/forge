"use client";

import { useParams } from "next/navigation";
import { WorkflowDesignScreen } from "@/features/workflows/components/workflow-design-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectWorkflowPage() {
  const params = useParams<{ slug: string; workflow: string }>();
  return (
    <ProjectGate label="loading workflow…">
      {(p) => <WorkflowDesignScreen projectId={p.id} slug={p.slug} flow={decodeURIComponent(params.workflow)} />}
    </ProjectGate>
  );
}
