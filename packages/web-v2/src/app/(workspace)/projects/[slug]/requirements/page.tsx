"use client";

import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectRequirementsPage() {
  return (
    <ProjectGate label="loading requirements…">
      {(p) => <RequirementsScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
