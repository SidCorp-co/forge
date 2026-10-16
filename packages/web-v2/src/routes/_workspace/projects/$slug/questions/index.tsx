import { createFileRoute } from "@tanstack/react-router";
import { QuestionDesk } from "@/features/question-desk";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

function ProjectQuestionsPage() {
  const t = useCopy();
  return <ProjectRefGate label={t("questionDesk.loading")}>{(p) => <QuestionDesk projectId={p.ref} slug={p.slug} />}</ProjectRefGate>;
}

export const Route = createFileRoute("/_workspace/projects/$slug/questions/")({ component: ProjectQuestionsPage });
