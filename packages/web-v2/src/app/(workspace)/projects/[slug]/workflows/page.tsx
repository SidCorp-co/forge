"use client";

import { WorkflowsScreen } from "@/features/workflows/components/workflows-screen";
import { ProjectGate } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";
import { canManageProject } from "@/features/projects";

export default function ProjectWorkflowsPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("workflows.loadingList")}>
      {(p) => <WorkflowsScreen projectId={p.id} slug={p.slug} projectName={p.name} canEdit={canManageProject(p.role)} />}
    </ProjectGate>
  );
}
