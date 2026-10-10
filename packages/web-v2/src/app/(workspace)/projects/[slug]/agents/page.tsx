"use client";

import { AgentsScreen } from "@/features/agents";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";
import { canWriteProject } from "@/features/projects";

export default function ProjectAgentsPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.agents")}>
      {(p) => <AgentsScreen access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role) }} />}
    </ProjectGate>
  );
}
