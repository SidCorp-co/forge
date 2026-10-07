"use client";

import { AgentsScreen } from "@/features/agents/components/agents-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { canWriteProject } from "@/features/projects/write-access";

export default function ProjectAgentsPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.agents")}>
      {(p) => <AgentsScreen access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role) }} />}
    </ProjectGate>
  );
}
