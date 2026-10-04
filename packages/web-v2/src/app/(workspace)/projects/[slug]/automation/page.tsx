"use client";

import { AutomationScreen } from "@/features/automation/components/automation-screen";
import { canWriteProject } from "@/features/projects/write-access";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectAutomationPage() {
  return (
    <ProjectGate label="loading automation…">
      {(p) => (
        <AutomationScreen
          access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role), canManage: p.role === "admin" }}
        />
      )}
    </ProjectGate>
  );
}
