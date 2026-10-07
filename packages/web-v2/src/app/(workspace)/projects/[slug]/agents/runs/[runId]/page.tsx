"use client";

import { useParams } from "next/navigation";
import { RunItemScreen } from "@/features/agents/components/agents-item-screens";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { canWriteProject } from "@/features/projects/write-access";

export default function Page() {
  const t = useCopy();
  const params = useParams<{ runId: string }>();
  const id = decodeURIComponent(params?.runId ?? "");
  return (
    <ProjectGate label={t("runs.loadingRun")}>
      {(p) => <RunItemScreen access={{ projectId: p.id, slug: p.slug, canWrite: canWriteProject(p.role) }} runId={id} />}
    </ProjectGate>
  );
}
