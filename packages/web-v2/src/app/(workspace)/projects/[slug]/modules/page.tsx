"use client";

import { ModulesScreen } from "@/features/modules/components/modules-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectModulesPage() {
  return (
    <ProjectGate label="loading modules…">
      {(p) => <ModulesScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
