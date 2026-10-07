"use client";

import { IssuesScreen } from "@/features/issues/components/issues-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectIssuesPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("issues.board.loading")}>
      {(p) => <IssuesScreen scope={{ projectId: p.id, slug: p.slug }} />}
    </ProjectGate>
  );
}
