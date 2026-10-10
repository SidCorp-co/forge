"use client";

import { ModulesScreen } from "@/features/modules";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects";

export default function ProjectModulesPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.modules")}>
      {(p) => <ModulesScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
