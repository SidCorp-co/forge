"use client";

import { ModulesScreen } from "@/features/modules/components/modules-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectModulesPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.modules")}>
      {(p) => <ModulesScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
