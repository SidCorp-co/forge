"use client";

import { ImprovementsScreen } from "@/features/improvement-messages/components/improvements-screen";
import { canWriteProject } from "@/features/projects/write-access";
import { ProjectGate } from "../project-gate";

export default function ProjectImprovementsPage() {
  return (
    <ProjectGate label="loading improvements…">
      {(p) => (
        <ImprovementsScreen
          scope={{ projectId: p.id, slug: p.slug, canManage: p.role === "admin", canWrite: canWriteProject(p.role) }}
        />
      )}
    </ProjectGate>
  );
}
