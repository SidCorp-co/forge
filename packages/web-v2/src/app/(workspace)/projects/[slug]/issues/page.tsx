"use client";

import { IssuesScreen } from "@/features/issues/components/issues-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

export default function ProjectIssuesPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("issues.board.loading")}>
      {(p) => <IssuesScreen scope={{ projectId: p.ref, slug: p.slug }} />}
    </ProjectRefGate>
  );
}
