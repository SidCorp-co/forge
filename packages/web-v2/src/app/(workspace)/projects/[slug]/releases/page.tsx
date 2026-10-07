"use client";

import { ReleasesScreen } from "@/features/releases/components/releases-screen";
import { ProjectGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectReleasesPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("releases.loadingList")}>
      {(p) => <ReleasesScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
