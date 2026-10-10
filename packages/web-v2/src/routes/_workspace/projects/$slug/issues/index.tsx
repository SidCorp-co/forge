import { createFileRoute } from "@tanstack/react-router";
import { IssuesScreen } from "@/features/issues";
import { useCopy } from "@/lib/i18n/interface-language";
import { ProjectRefGate } from "@/features/projects/components/project-gate";

function ProjectIssuesPage() {
  const t = useCopy();
  return (
    <ProjectRefGate label={t("issues.board.loading")}>
      {(p) => <IssuesScreen scope={{ projectId: p.ref, slug: p.slug }} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/issues/")({ component: ProjectIssuesPage });
