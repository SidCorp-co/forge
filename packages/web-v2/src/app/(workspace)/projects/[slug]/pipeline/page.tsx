"use client";

import { PipelineBoard } from "@/features/pipeline/components/pipeline-board";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectPipelinePage() {
  return (
    <ProjectGate label="loading pipeline…">
      {(p) => <PipelineBoard scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}
