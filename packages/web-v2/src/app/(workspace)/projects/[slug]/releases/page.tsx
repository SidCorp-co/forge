"use client";

import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectReleasesPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("releases.loadingList")}>
      {(p) => <ReleasesScreen projectId={p.ref} slug={p.slug} />}
    </ProjectRefGate>
  );
}
