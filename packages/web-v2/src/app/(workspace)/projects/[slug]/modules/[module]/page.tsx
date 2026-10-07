"use client";

import { useParams } from "next/navigation";
import { ModuleScreen } from "@/features/modules/components/module-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectModulePage() {
  const t = useCopy();
  const params = useParams<{ slug: string; module: string }>();
  return (
    <ProjectGate label={t("common.gate.module")}>
      {(p) => <ModuleScreen projectId={p.id} slug={p.slug} moduleSlug={decodeURIComponent(params.module)} />}
    </ProjectGate>
  );
}
