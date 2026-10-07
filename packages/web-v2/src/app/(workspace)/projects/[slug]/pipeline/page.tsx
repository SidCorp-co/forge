"use client";

import { PipelineBoard } from "@/features/pipeline/components/pipeline-board";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectPipelinePage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.pipeline")}>
      {(p) => <PipelineBoard scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}
