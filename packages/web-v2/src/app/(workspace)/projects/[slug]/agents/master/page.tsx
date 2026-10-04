"use client";

import { MasterItemScreen } from "@/features/agents/components/agents-item-screens";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { canWriteProject } from "@/features/projects/write-access";

export default function Page() {
  return (
    <ProjectGate label="loading the master…">
      {(p) => <MasterItemScreen access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role) }} />}
    </ProjectGate>
  );
}
