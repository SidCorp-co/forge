import { createFileRoute } from "@tanstack/react-router";
import { LessonsPage } from "@/features/lessons";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectLessonsPage() {
  const t = useCopy();
  return <ProjectRefGate label={t("lessons.loading")}>{(p) => <LessonsPage projectId={p.ref} />}</ProjectRefGate>;
}

export const Route = createFileRoute("/_workspace/projects/$slug/lessons/")({ component: ProjectLessonsPage });
