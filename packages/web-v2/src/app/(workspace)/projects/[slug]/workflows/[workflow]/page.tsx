"use client";

import { useParams } from "next/navigation";
import { WorkflowDesignScreen } from "@/features/workflows/components/workflow-design-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectWorkflowPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; workflow: string }>();
  return (
    <ProjectGate label={t("workflows.loadingOne")}>
      {(p) => <WorkflowDesignScreen projectId={p.id} slug={p.slug} flow={decodeURIComponent(params.workflow)} />}
    </ProjectGate>
  );
}
