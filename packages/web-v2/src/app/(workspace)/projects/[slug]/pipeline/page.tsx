"use client";

import { PipelineBoard } from "@/features/pipeline";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

export default function ProjectPipelinePage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.pipeline")}>
      {(p) => <PipelineBoard scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}
