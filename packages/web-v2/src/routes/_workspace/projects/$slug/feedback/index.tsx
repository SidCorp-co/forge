import { createFileRoute } from "@tanstack/react-router";
import { FeedbackScreen } from "@/features/feedback";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

function ProjectFeedbackPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("feedback.loading")}>
      {(p) => <FeedbackScreen projectId={p.ref} slug={p.slug} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/feedback/")({ component: ProjectFeedbackPage });
