"use client";

import { PageContainer } from "@/design";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { DecisionLog } from "@/features/requirements/components/decision-log";
import { useCopy } from "@/lib/i18n/interface-language";

export default function ProjectDecisionsPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("common.decisions.loading")}>
      {(p) => (
        <PageContainer className="max-w-[1100px]">
          <DecisionLog projectId={p.ref} slug={p.slug} />
        </PageContainer>
      )}
    </ProjectRefGate>
  );
}
