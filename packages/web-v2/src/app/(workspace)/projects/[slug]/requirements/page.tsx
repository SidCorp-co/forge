"use client";

import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectRequirementsPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("requirements.loadingList")}>
      {(p) => <RequirementsScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
