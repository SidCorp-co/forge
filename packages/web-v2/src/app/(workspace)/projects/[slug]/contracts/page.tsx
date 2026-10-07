"use client";

import { ContractsScreen } from "@/features/contracts/components/contracts-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectContractsPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("common.gate.contracts")}>
      {(p) => <ContractsScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
