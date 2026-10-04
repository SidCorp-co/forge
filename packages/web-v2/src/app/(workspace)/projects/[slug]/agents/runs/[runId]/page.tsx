"use client";

import { useParams } from "next/navigation";
import { RunItemScreen } from "@/features/agents/components/agents-item-screens";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { canWriteProject } from "@/features/projects/write-access";

export default function Page() {
  const params = useParams<{ runId: string }>();
  const id = decodeURIComponent(params?.runId ?? "");
  return (
    <ProjectGate label="loading the run…">
      {(p) => <RunItemScreen access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role) }} runId={id} />}
    </ProjectGate>
  );
}
