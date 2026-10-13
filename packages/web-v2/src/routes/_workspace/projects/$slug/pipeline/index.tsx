import { createFileRoute } from "@tanstack/react-router";
import { PipelineBoard } from "@/features/pipeline";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

function ProjectPipelinePage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.pipeline")}>
      {(p) => <PipelineBoard scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/pipeline/")({ component: ProjectPipelinePage });
