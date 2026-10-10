import { createFileRoute } from "@tanstack/react-router";
import { useParams } from "@/lib/navigation/router";
import { RequirementScreen } from "@/features/requirements/components/requirement-screen";
import { ProjectRefGate } from "@/features/projects/components/project-gate";
import { useCopy } from "@/lib/i18n/interface-language";

function ProjectRequirementPage() {
  const t = useCopy();
  const params = useParams<{ slug: string; requirement: string }>();
  return (
    <ProjectRefGate label={t("requirements.loadingOne")}>
      {(p) => <RequirementScreen projectId={p.ref} slug={p.slug} reqKey={decodeURIComponent(params.requirement)} />}
    </ProjectRefGate>
  );
}

export const Route = createFileRoute("/_workspace/projects/$slug/requirements/$requirement/")({ component: ProjectRequirementPage });
