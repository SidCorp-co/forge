"use client";

import { ContractsScreen } from "@/features/contracts/components/contracts-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectContractsPage() {
  return (
    <ProjectGate label="loading contracts…">
      {(p) => <ContractsScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
