import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { FeedbackItemScreen } from "@/features/feedback";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

function ProjectFeedbackItemPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; feedback: string }>();
  return (
    <ProjectRefGate label={t("feedback.loading")}>
      {(p) => <FeedbackItemScreen projectId={p.ref} slug={p.slug} fbKey={decodeURIComponent(params.feedback)} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/feedback/$feedback/")({ component: ProjectFeedbackItemPage });
