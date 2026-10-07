"use client";

import { DevelopmentOverviewScreen } from "@/features/development/components/development-overview-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function DevelopmentOverviewPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("overview.dev.loading")}>
      {(p) => <DevelopmentOverviewScreen scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}
