"use client";

import { useParams } from "next/navigation";
import { FeedbackItemScreen } from "@/features/feedback/components/feedback-item-screen";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

export default function ProjectFeedbackItemPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; feedback: string }>();
  return (
    <ProjectRefGate label={t("feedback.loading")}>
      {(p) => <FeedbackItemScreen projectId={p.ref} slug={p.slug} fbKey={decodeURIComponent(params.feedback)} />}
    </ProjectRefGate>
  );
}
