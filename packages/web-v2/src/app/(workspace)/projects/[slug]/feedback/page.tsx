"use client";

import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectGate } from "@/features/projects/components/project-gate";

export default function ProjectFeedbackPage() {
  const t = useCopy();
  return (
    <ProjectGate label={t("feedback.loading")}>
      {(p) => <FeedbackScreen projectId={p.id} slug={p.slug} />}
    </ProjectGate>
  );
}
