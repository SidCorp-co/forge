import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { WorkflowDesignScreen } from "@/features/workflows/components/workflow-design-screen";
import { ProjectGate } from "@/features/projects";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectWorkflowPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; workflow: string }>();
  return (
    <ProjectGate label={t("workflows.loadingOne")}>
      {(p) => <WorkflowDesignScreen projectId={p.id} slug={p.slug} flow={decodeURIComponent(params.workflow)} />}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/workflows/$workflow/")({ component: ProjectWorkflowPage });
