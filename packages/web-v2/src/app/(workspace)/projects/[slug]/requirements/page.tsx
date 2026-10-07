"use client";

import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectRequirementsPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("requirements.loadingList")}>
      {(p) => <RequirementsScreen projectId={p.ref} slug={p.slug} />}
    </ProjectRefGate>
  );
}
