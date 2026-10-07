"use client";

import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

export default function ProjectFeedbackPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("feedback.loading")}>
      {(p) => <FeedbackScreen projectId={p.ref} slug={p.slug} />}
    </ProjectRefGate>
  );
}
